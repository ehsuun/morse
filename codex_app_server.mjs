import { EventEmitter } from 'node:events';
import { parseCommandLine, resolveExecutable, spawnCommand } from './helpers.mjs';

export class CodexAppServer extends EventEmitter {
  constructor({
    command = 'codex app-server --listen ws://127.0.0.1:17373',
    url = 'ws://127.0.0.1:17373',
    cwd = process.cwd(),
    allowReuse = false,
  } = {}) {
    super();
    this.command = command;
    this.url = url;
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.contentLength = null;
    this.started = false;
    this.allowReuse = allowReuse;
  }

  async start() {
    if (this.started) return;
    if (this.url?.startsWith('ws://') || this.url?.startsWith('wss://')) {
      await this.startWebSocket();
      return;
    }
    await this.startStdio();
  }

  async startWebSocket() {
    const hasOwnedChild = this.hasLiveChild();

    if ((this.allowReuse || hasOwnedChild) && await this.tryConnectWebSocket()) {
      this.started = true;
      await this.initialize();
      return;
    }

    if (hasOwnedChild) {
      this.stopChild();
      await this.waitForWebSocketClose();
    } else if (!this.allowReuse && await this.probeWebSocket()) {
      throw new Error(`refusing to relay through an existing app-server at ${this.url}`);
    }

    this.spawnAppServer();
    await this.waitForWebSocket();
    this.started = true;
    await this.initialize();
  }

  async startStdio() {
    const [bin, ...args] = parseCommandLine(this.command);
    const resolvedBin = resolveExecutable(bin) ?? bin;
    this.child = spawnCommand(resolvedBin, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.started = true;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.read(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.emit('stderr', chunk));
    this.child.on('error', (err) => this.rejectAll(err));
    this.child.on('close', (code, signal) => {
      this.started = false;
      this.rejectAll(new Error(`Codex app-server exited${code === null ? '' : ` ${code}`}${signal ? ` (${signal})` : ''}`));
    });

    await this.initialize();
  }

  spawnAppServer() {
    const [bin, ...args] = parseCommandLine(this.command);
    const resolvedBin = resolveExecutable(bin) ?? bin;
    this.child = spawnCommand(resolvedBin, args, {
      cwd: this.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.emit('stderr', chunk));
    this.child.on('error', (err) => this.rejectAll(err));
    this.child.on('close', (code, signal) => {
      this.started = false;
      this.rejectAll(new Error(`Codex app-server exited${code === null ? '' : ` ${code}`}${signal ? ` (${signal})` : ''}`));
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'morse', title: 'morse', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    });
  }

  stop() {
    this.stopChild();
    if (this.ws) this.ws.close();
  }

  stopChild() {
    if (this.hasLiveChild()) this.child.kill('SIGTERM');
  }

  hasLiveChild() {
    return Boolean(
      this.child
        && !this.child.killed
        && this.child.exitCode === null
        && this.child.signalCode === null,
    );
  }

  async tryConnectWebSocket() {
    try {
      await this.connectWebSocket();
      return true;
    } catch {
      return false;
    }
  }

  probeWebSocket() {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 500);

      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  async waitForWebSocket() {
    let lastError;
    for (let i = 0; i < 40; i++) {
      try {
        await this.connectWebSocket();
        return;
      } catch (err) {
        lastError = err;
        await sleep(250);
      }
    }
    throw lastError ?? new Error(`could not connect to Codex app-server at ${this.url}`);
  }

  async waitForWebSocketClose() {
    for (let i = 0; i < 20; i++) {
      if (!await this.probeWebSocket()) return;
      await sleep(100);
    }
    throw new Error(`owned Codex app-server at ${this.url} did not stop`);
  }

  connectWebSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out connecting to ${this.url}`));
      }, 2000);

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        ws.onmessage = (event) => this.handleJson(String(event.data));
        ws.onerror = () => {};
        ws.onclose = () => {
          if (this.ws === ws) this.ws = null;
          this.started = false;
          this.rejectAll(new Error(`Codex app-server websocket closed`));
        };
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${this.url}`));
      };
    });
  }

  async relayTurn({ cwd, text, inputItems = null, threadId, onStarted, onDelta, timeoutMs = 600000 }) {
    await this.start();
    const thread = threadId ? { id: threadId, cwd } : await this.getOrCreateThread(cwd);
    let output = '';
    let turnId = null;
    const agentItemText = new Map();

    return await new Promise((resolve, reject) => {
      const buffered = [];
      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.off('notification', onNotification);
        this.off('server-error', onServerError);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const complete = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const append = (delta, itemId) => {
        if (!delta) return;
        output += delta;
        if (itemId) agentItemText.set(itemId, `${agentItemText.get(itemId) ?? ''}${delta}`);
        onDelta?.(delta, output);
      };
      const appendCompletedAgentItem = (item) => {
        const text = agentTextFromItem(item);
        if (!text) return;
        const existing = agentItemText.get(item.id) ?? '';
        if (text === existing) return;
        append(text.startsWith(existing) ? text.slice(existing.length) : text, item.id);
      };
      const resolveCompleted = async (turn) => {
        const error = turn?.error;
        if (error) {
          fail(new Error(error.message || 'Codex turn failed'));
          return;
        }

        if (!output) {
          const finalOutput = await this.readTurnAgentText(thread.id, turnId);
          if (finalOutput) {
            output = finalOutput;
            onDelta?.(finalOutput, output);
          }
        }

        complete({ threadId: thread.id, turnId, output, status: turn?.status });
      };
      const onServerError = (params) => {
        if (params?.threadId === thread.id && params?.turnId === turnId) {
          fail(new Error(params.error?.message || 'Codex turn failed'));
        }
      };
      const onNotification = (message) => {
        const { method, params } = message;
        if (params?.threadId !== thread.id) return;
        if (!turnId) {
          buffered.push(message);
          return;
        }
        if (params?.turnId && params.turnId !== turnId) return;

        if (method === 'item/agentMessage/delta') {
          append(params.delta || '', params.itemId);
        } else if (method === 'item/completed') {
          appendCompletedAgentItem(params.item);
        } else if (method === 'turn/completed' && params.turn?.id === turnId) {
          resolveCompleted(params.turn).catch(reject);
        }
      };
      this.on('notification', onNotification);
      this.on('server-error', onServerError);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          fail(new Error(`Codex turn timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }

      this.request('turn/start', {
        threadId: thread.id,
        cwd,
        input: inputItems ?? [textInput(text)],
      }).then((turn) => {
        turnId = turn.turn.id;
        onStarted?.({ threadId: thread.id, turnId });
        for (const message of buffered.splice(0)) onNotification(message);
      }, fail);
    });
  }

  async readTurnAgentText(threadId, turnId) {
    try {
      const { thread } = await this.request('thread/read', { threadId, includeTurns: true });
      const turn = thread?.turns?.find((candidate) => candidate.id === turnId);
      return agentTextFromTurn(turn);
    } catch {
      return '';
    }
  }

  async interrupt(threadId, turnId) {
    await this.start();
    return await this.request('turn/interrupt', { threadId, turnId });
  }

  async resumeThread(threadId, cwd) {
    const resumed = await this.request('thread/resume', { threadId, cwd, persistExtendedHistory: true });
    return resumed.thread ?? { id: threadId, cwd };
  }

  async getOrCreateThread(cwd) {
    const loaded = await this.request('thread/loaded/list', { limit: 20 });
    for (const threadId of loaded.data ?? []) {
      try {
        const { thread } = await this.request('thread/read', { threadId, includeTurns: false });
        if (samePath(thread.cwd, cwd)) {
          const resumed = await this.request('thread/resume', { threadId: thread.id, cwd, persistExtendedHistory: true });
          return resumed.thread ?? thread;
        }
      } catch {
        // Ignore stale loaded ids.
      }
    }

    const list = await this.request('thread/list', {
      cwd,
      limit: 1,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      sourceKinds: ['cli', 'vscode', 'appServer'],
    });
    if (list.data?.[0]) {
      const thread = list.data[0];
      await this.request('thread/resume', { threadId: thread.id, cwd, persistExtendedHistory: true });
      return thread;
    }

    const started = await this.request('thread/start', {
      cwd,
      sessionStartSource: 'startup',
      approvalPolicy: null,
      sandbox: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    return started.thread;
  }

  request(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(message);
    });
  }

  write(message) {
    const json = JSON.stringify(message);
    if (this.ws) {
      this.ws.send(json);
    } else {
      this.child.stdin.write(`${json}\n`);
    }
  }

  read(chunk) {
    this.buffer += chunk;
    while (this.buffer) {
      if (this.contentLength !== null) {
        if (this.buffer.length < this.contentLength) return;
        const payload = this.buffer.slice(0, this.contentLength);
        this.buffer = this.buffer.slice(this.contentLength);
        this.contentLength = null;
        this.handleJson(payload);
        continue;
      }

      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd >= 0 && /^Content-Length:/i.test(this.buffer.slice(0, headerEnd))) {
        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        this.buffer = this.buffer.slice(headerEnd + 4);
        this.contentLength = match ? Number(match[1]) : null;
        continue;
      }

      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleJson(line);
    }
  }

  handleJson(payload) {
    let message;
    try {
      message = JSON.parse(payload);
    } catch (err) {
      this.emit('stderr', `failed to parse app-server message: ${err.message}\n${payload}\n`);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit('request', message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === 'error') {
      this.emit('server-error', message.params);
    }
    this.emit('notification', message);
  }

  respond(id, result) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message) {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  rejectAll(err) {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    this.emit('fatal', err);
  }
}

function samePath(a, b) {
  if (process.platform === 'win32') return String(a).toLowerCase() === String(b).toLowerCase();
  return String(a) === String(b);
}

export function agentTextFromTurn(turn) {
  return (turn?.items ?? [])
    .map(agentTextFromItem)
    .filter(Boolean)
    .join('\n\n');
}

export function agentTextFromItem(item) {
  return item?.type === 'agentMessage' && typeof item.text === 'string' ? item.text : '';
}

function textInput(text) {
  return { type: 'text', text, text_elements: [] };
}

export function turnInputFromTextAndAttachments(text, attachments = []) {
  return [
    ...(String(text ?? '') ? [textInput(String(text))] : []),
    ...attachments.map((attachment) => {
      if (attachment.type === 'localImage') return { type: 'localImage', path: attachment.path };
      if (attachment.type === 'image') return { type: 'image', url: attachment.url };
      return attachment;
    }),
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
