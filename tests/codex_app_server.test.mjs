import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServer, agentTextFromItem, agentTextFromTurn } from '../codex_app_server.mjs';

test('agentTextFromItem extracts completed agent messages', () => {
  assert.equal(agentTextFromItem({ type: 'agentMessage', text: 'hello from Codex' }), 'hello from Codex');
});

test('agentTextFromItem ignores non-agent items', () => {
  assert.equal(agentTextFromItem({ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }), '');
});

test('agentTextFromTurn joins agent message items', () => {
  assert.equal(
    agentTextFromTurn({
      id: 'turn-1',
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
        { type: 'agentMessage', text: 'first' },
        { type: 'agentMessage', text: 'second' },
      ],
    }),
    'first\n\nsecond',
  );
});

test('relayTurn captures notifications emitted before turn/start resolves', async () => {
  const server = new CodexAppServer();
  server.start = async () => {};
  server.getOrCreateThread = async () => ({ id: 'thread-1' });
  server.request = async (method) => {
    if (method === 'turn/start') {
      server.emit('notification', {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { id: 'item-1', type: 'agentMessage', text: 'fast reply' },
        },
      });
      server.emit('notification', {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
      });
      return { turn: { id: 'turn-1' } };
    }
    throw new Error(`unexpected request: ${method}`);
  };

  let streamed = '';
  const result = await server.relayTurn({
    cwd: process.cwd(),
    text: 'hi',
    timeoutMs: 1000,
    onDelta: (delta) => {
      streamed += delta;
    },
  });

  assert.equal(streamed, 'fast reply');
  assert.equal(result.output, 'fast reply');
});

test('getOrCreateThread resumes matching loaded threads so this client subscribes', async () => {
  const server = new CodexAppServer();
  const calls = [];
  server.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/loaded/list') return { data: ['thread-1'] };
    if (method === 'thread/read') return { thread: { id: 'thread-1', cwd: process.cwd() } };
    if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: process.cwd(), resumed: true } };
    throw new Error(`unexpected request: ${method}`);
  };

  const thread = await server.getOrCreateThread(process.cwd());

  assert.equal(thread.resumed, true);
  assert.deepEqual(calls.map((call) => call.method), ['thread/loaded/list', 'thread/read', 'thread/resume']);
});

test('handleJson emits server requests instead of treating them as responses', async () => {
  const server = new CodexAppServer();
  const request = await new Promise((resolve) => {
    server.on('request', resolve);
    server.handleJson(JSON.stringify({
      jsonrpc: '2.0',
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'npm test' },
    }));
  });

  assert.equal(request.id, 'approval-1');
  assert.equal(request.method, 'item/commandExecution/requestApproval');
  assert.equal(request.params.command, 'npm test');
});

test('startWebSocket refuses existing servers by default', async () => {
  const server = new CodexAppServer();
  server.probeWebSocket = async () => true;
  server.spawnAppServer = () => {
    throw new Error('should not spawn');
  };

  await assert.rejects(() => server.startWebSocket(), /refusing to relay/);
});

test('startWebSocket can reuse an existing server when explicitly allowed', async () => {
  const server = new CodexAppServer({ allowReuse: true });
  let connected = false;
  server.tryConnectWebSocket = async () => {
    connected = true;
    return true;
  };
  server.initialize = async () => {};
  server.spawnAppServer = () => {
    throw new Error('should not spawn');
  };

  await server.startWebSocket();

  assert.equal(connected, true);
  assert.equal(server.started, true);
});

test('startWebSocket reconnects to a live child this instance spawned', async () => {
  const server = new CodexAppServer();
  let connected = false;
  server.child = { killed: false, exitCode: null, signalCode: null, kill: () => assert.fail('should not kill child') };
  server.tryConnectWebSocket = async () => {
    connected = true;
    return true;
  };
  server.probeWebSocket = async () => assert.fail('should not probe owned child as foreign server');
  server.initialize = async () => {};
  server.spawnAppServer = () => assert.fail('should not spawn');

  await server.startWebSocket();

  assert.equal(connected, true);
  assert.equal(server.started, true);
});

test('startWebSocket restarts an owned child if reconnect fails', async () => {
  const server = new CodexAppServer();
  let killed = false;
  let spawned = false;
  server.child = { killed: false, exitCode: null, signalCode: null, kill: () => { killed = true; } };
  server.tryConnectWebSocket = async () => false;
  server.probeWebSocket = async () => false;
  server.spawnAppServer = () => { spawned = true; };
  server.waitForWebSocket = async () => {};
  server.initialize = async () => {};

  await server.startWebSocket();

  assert.equal(killed, true);
  assert.equal(spawned, true);
  assert.equal(server.started, true);
});
