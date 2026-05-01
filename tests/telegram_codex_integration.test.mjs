import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const integrationTest = process.env.MORSE_INTEGRATION === '1' ? test : test.skip;

integrationTest('fake Telegram: duplicate session edit does not leak an error message', async () => {
  await withIntegrationHarness(async ({ dir, telegram, startBot }) => {
    seedConfig(dir);
    const bot = startBot();
    seedSessions(dir, [{
      id: 'same1234',
      label: 'Repo A',
      pid: bot.pid,
      appServerUrl: 'ws://127.0.0.1:1',
      appServerCommand: 'codex app-server --listen ws://127.0.0.1:1',
      proxyUrl: 'ws://127.0.0.1:1',
      activeThreadId: 'thread-a',
      cwd: dir,
      updatedAt: '2026-04-27T01:00:00.000Z',
    }], { 123: { activeSessionId: 'same1234', updatedAt: '2026-04-27T01:00:00.000Z' } });

    telegram.injectMessage('/sessions');
    await telegram.waitForCall('sendMessage', (call) => call.body.text.startsWith('Codex sessions'));

    telegram.failNextEditNoop = true;
    telegram.injectCallback({
      data: 'sess:same1234',
      messageId: 1,
      text: 'Codex sessions\n\n* Repo A (same1234)',
    });

    await telegram.waitForCall('answerCallbackQuery', (call) => call.body.callback_query_id === 'cb-2');
    await sleep(200);

    assert.equal(
      telegram.calls.some((call) => call.method === 'sendMessage' && String(call.body.text).startsWith('error:')),
      false,
    );
    await bot.stop();
  });
});

integrationTest('fake Telegram + fake Codex: Telegram prompt is relayed and streamed back', async () => {
  await withIntegrationHarness(async ({ dir, telegram, startBot }) => {
    const codex = await FakeCodexServer.start();
    try {
      seedConfig(dir);
      const bot = startBot();
      seedSessions(dir, [{
        id: 'codex123',
        label: 'Repo B',
        pid: bot.pid,
        appServerUrl: codex.url,
        appServerCommand: `codex app-server --listen ${codex.url}`,
        proxyUrl: codex.url,
        activeThreadId: 'thread-b',
        cwd: dir,
        updatedAt: '2026-04-27T02:00:00.000Z',
      }], { 123: { activeSessionId: 'codex123', updatedAt: '2026-04-27T02:00:00.000Z' } });

      telegram.injectMessage('hello from telegram');

      try {
        await codex.waitForTurn((turn) => turn.params.threadId === 'thread-b');
        await telegram.waitForCall('editMessageText', (call) => call.body.text === 'fake codex reply');
      } catch (err) {
        assert.fail([
          err.message,
          `telegram_calls=${JSON.stringify(telegram.calls)}`,
          `bot_output=${JSON.stringify(bot.output)}`,
          `codex_turns=${JSON.stringify(codex.turns)}`,
        ].join('\n'));
      }

      assert.equal(codex.turns[0].params.input[0].text, 'hello from telegram');
      await bot.stop();
    } finally {
      await codex.close();
    }
  });
});

async function withIntegrationHarness(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'morse-integration-'));
  const telegram = await FakeTelegramServer.start();
  const children = new Set();
  try {
    await fn({
      dir,
      telegram,
      startBot() {
        const child = spawn(process.execPath, [resolve('bot.mjs'), 'start', '--foreground'], {
          cwd: resolve('.'),
          env: {
            ...process.env,
            MORSE_CONFIG: join(dir, 'config.json'),
            MORSE_TELEGRAM_API_BASE: telegram.baseUrl,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const output = [];
        child.stdout.on('data', (chunk) => output.push(String(chunk)));
        child.stderr.on('data', (chunk) => output.push(String(chunk)));
        children.add(child);
        return {
          pid: child.pid,
          output,
          async stop() {
            if (child.exitCode !== null) return;
            child.kill('SIGTERM');
            await onceExit(child, 3000);
          },
        };
      },
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await onceExit(child, 3000).catch(() => {});
      }
    }
    await telegram.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedConfig(dir) {
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({
    telegramBotToken: 'TEST_TOKEN',
    allowedUserIds: [42],
    allowedChatIds: [123],
    activeWorkspace: { cwd: dir, label: 'integration', enabledAt: '2026-04-27T00:00:00.000Z' },
    timeoutSeconds: 5,
    streamDebounceMs: 10,
  }, null, 2)}\n`);
}

function seedSessions(dir, sessions, chats = {}) {
  writeFileSync(join(dir, 'sessions.json'), `${JSON.stringify({ sessions, chats }, null, 2)}\n`);
}

class FakeTelegramServer {
  constructor(server) {
    this.server = server;
    this.calls = [];
    this.updates = [];
    this.nextUpdateId = 1;
    this.nextMessageId = 1;
    this.failNextEditNoop = false;
  }

  static async start() {
    const fake = new FakeTelegramServer(createServer());
    fake.server.on('request', (req, res) => fake.handle(req, res));
    await listen(fake.server);
    const { port } = fake.server.address();
    fake.baseUrl = `http://127.0.0.1:${port}`;
    return fake;
  }

  injectMessage(text) {
    this.updates.push({
      update_id: this.nextUpdateId++,
      message: {
        message_id: this.nextMessageId++,
        from: { id: 42, is_bot: false, first_name: 'Tester' },
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    });
  }

  injectCallback({ data, messageId = 1, text = '' }) {
    this.updates.push({
      update_id: this.nextUpdateId++,
      callback_query: {
        id: `cb-${this.nextUpdateId - 1}`,
        from: { id: 42, is_bot: false, first_name: 'Tester' },
        message: {
          message_id: messageId,
          chat: { id: 123, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text,
        },
        chat_instance: 'chat-instance',
        data,
      },
    });
  }

  async handle(req, res) {
    const method = req.url.split('/').at(-1);
    const body = await readJsonBody(req);
    this.calls.push({ method, body });

    if (method === 'getUpdates') {
      const offset = Number(body.offset ?? 0);
      this.respond(res, this.updates.filter((update) => update.update_id >= offset));
      return;
    }
    if (method === 'sendMessage') {
      this.respond(res, {
        message_id: this.nextMessageId++,
        from: { id: 999, is_bot: true, first_name: 'morse' },
        chat: { id: body.chat_id, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: body.text,
      });
      return;
    }
    if (method === 'editMessageText' && this.failNextEditNoop) {
      this.failNextEditNoop = false;
      this.respond(res, null, {
        ok: false,
        description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
      });
      return;
    }
    if (method === 'editMessageText') {
      this.respond(res, {
        message_id: body.message_id,
        chat: { id: body.chat_id, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: body.text,
      });
      return;
    }
    if (method === 'answerCallbackQuery' || method === 'editMessageReplyMarkup') {
      this.respond(res, true);
      return;
    }
    this.respond(res, true);
  }

  respond(res, result, override = null) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(override ?? { ok: true, result }));
  }

  waitForCall(method, predicate = () => true) {
    return waitFor(() => this.calls.find((call) => call.method === method && predicate(call)));
  }

  close() {
    return closeServer(this.server);
  }
}

class FakeCodexServer {
  constructor(server) {
    this.server = server;
    this.turns = [];
    this.connections = new Set();
  }

  static async start() {
    const fake = new FakeCodexServer(createServer());
    fake.server.on('upgrade', (req, socket) => fake.handleUpgrade(req, socket));
    await listen(fake.server);
    const { port } = fake.server.address();
    fake.url = `ws://127.0.0.1:${port}`;
    return fake;
  }

  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));

    const connection = { socket, buffer: Buffer.alloc(0) };
    this.connections.add(connection);
    socket.on('data', (chunk) => this.read(connection, chunk));
    socket.on('error', () => {});
    socket.on('close', () => this.connections.delete(connection));
  }

  read(connection, chunk) {
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    while (true) {
      const frame = readFrame(connection.buffer);
      if (!frame) return;
      connection.buffer = connection.buffer.slice(frame.bytes);
      if (frame.opcode === 0x8) return connection.socket.end();
      if (frame.opcode !== 0x1) continue;
      this.handleMessage(connection, frame.payload.toString('utf8'));
    }
  }

  handleMessage(connection, message) {
    const parsed = JSON.parse(message);
    if (parsed.method === 'initialize') {
      sendJson(connection.socket, {
        id: parsed.id,
        result: { userAgent: 'fake-codex', codexHome: null, platformFamily: 'test', platformOs: 'test' },
      });
      return;
    }
    if (parsed.method === 'turn/start') {
      const turn = { id: 'turn-fake', status: 'running' };
      this.turns.push(parsed);
      sendJson(connection.socket, { id: parsed.id, result: { turn } });
      sendJson(connection.socket, {
        method: 'turn/started',
        params: { threadId: parsed.params.threadId, turn },
      });
      sendJson(connection.socket, {
        method: 'item/agentMessage/delta',
        params: { threadId: parsed.params.threadId, turnId: turn.id, itemId: 'item-fake', delta: 'fake codex reply' },
      });
      sendJson(connection.socket, {
        method: 'turn/completed',
        params: { threadId: parsed.params.threadId, turn: { id: turn.id, status: 'completed' } },
      });
      return;
    }
    sendJson(connection.socket, { id: parsed.id, result: { data: [] } });
  }

  waitForTurn(predicate = () => true) {
    return waitFor(() => this.turns.find(predicate));
  }

  async close() {
    for (const connection of this.connections) connection.socket.destroy();
    await closeServer(this.server);
  }
}

function sendJson(socket, value) {
  sendFrame(socket, 0x1, Buffer.from(JSON.stringify(value)));
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  }
  if (buffer.length < offset + (masked ? 4 : 0) + length) return null;
  const mask = masked ? buffer.slice(offset, offset + 4) : null;
  if (masked) offset += 4;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, bytes: offset + length };
}

function sendFrame(socket, opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

function onceExit(child, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const tick = () => {
      const result = fn();
      if (result) {
        resolveWait(result);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('timed out waiting for integration event'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
