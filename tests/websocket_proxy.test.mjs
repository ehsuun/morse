import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexWebSocketProxy, isServerNotification, observeClientMessage, observeServerMessage } from '../websocket_proxy.mjs';

test('observeClientMessage waits for resume responses and detects turn requests', () => {
  assert.equal(
    observeClientMessage(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'thread/resume',
      params: { threadId: 'thread-terminal' },
    })),
    null,
  );
  assert.equal(
    observeClientMessage(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'turn/start',
      params: { threadId: 'thread-terminal', input: [] },
    })),
    'thread-terminal',
  );
});

test('observeServerMessage only treats start/resume responses as active threads', () => {
  assert.equal(
    observeServerMessage(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { thread: { id: 'thread-read' } },
    }), 'thread/read'),
    null,
  );
  assert.equal(
    observeServerMessage(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { thread: { id: 'thread-terminal' } },
    }), 'thread/resume'),
    'thread-terminal',
  );
});

test('observeServerMessage detects active thread notifications', () => {
  assert.equal(
    observeServerMessage(JSON.stringify({
      method: 'thread/started',
      params: { thread: { id: 'thread-new' } },
    })),
    'thread-new',
  );
  assert.equal(
    observeServerMessage(JSON.stringify({
      method: 'turn/started',
      params: { threadId: 'thread-terminal', turn: { id: 'turn-1' } },
    })),
    'thread-terminal',
  );
});

test('isServerNotification identifies broadcastable server notifications', () => {
  assert.equal(isServerNotification(JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-terminal', turnId: 'turn-1', delta: 'hi' },
  })), true);
  assert.equal(isServerNotification(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { turn: { id: 'turn-1' } },
  })), false);
  assert.equal(isServerNotification(JSON.stringify({
    jsonrpc: '2.0',
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: {},
  })), false);
});

test('proxy routes morse turn requests through the active terminal connection', () => {
  const proxy = new CodexWebSocketProxy();
  let terminalSent = null;
  const terminal = fakeConnection({
    morse: false,
    sendBackend: (message) => { terminalSent = message; },
  });
  const morse = fakeConnection({ morse: true });
  proxy.connections.add(terminal);
  proxy.connections.add(morse);
  proxy.activeThreadId = 'thread-terminal';
  proxy.activeConnection = terminal;

  const handled = proxy.handleClientMessage(morse, JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'turn/start',
    params: { threadId: 'thread-terminal', input: [{ type: 'text', text: 'hi', text_elements: [] }] },
  }));

  assert.equal(handled, true);
  const routed = JSON.parse(terminalSent);
  assert.equal(routed.method, 'turn/start');
  assert.notEqual(routed.id, 7);

  const responseHandled = proxy.handleServerMessage(terminal, JSON.stringify({
    jsonrpc: '2.0',
    id: routed.id,
    result: { turn: { id: 'turn-1' } },
  }), 'turn/start');

  assert.equal(responseHandled, true);
  assert.deepEqual(JSON.parse(morse.sentTexts[0]), {
    jsonrpc: '2.0',
    id: 7,
    result: { turn: { id: 'turn-1' } },
  });
});

test('proxy reports active terminal connection that is gone', () => {
  const proxy = new CodexWebSocketProxy();
  const terminal = fakeConnection({ morse: false });
  const morse = fakeConnection({ morse: true });
  terminal.closed = true;
  proxy.connections.add(terminal);
  proxy.connections.add(morse);
  proxy.activeThreadId = 'thread-terminal';
  proxy.activeConnection = terminal;

  const handled = proxy.handleClientMessage(morse, JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'turn/start',
    params: { threadId: 'thread-terminal', input: [{ type: 'text', text: 'hi', text_elements: [] }] },
  }));

  assert.equal(handled, true);
  const response = JSON.parse(morse.sentTexts[0]);
  assert.equal(response.id, 7);
  assert.match(response.error.message, /not connected/);
});

test('proxy reports active terminal websocket that is not ready', () => {
  const proxy = new CodexWebSocketProxy();
  const terminal = fakeConnection({ morse: false });
  const morse = fakeConnection({ morse: true });
  terminal.backendOpen = false;
  proxy.connections.add(terminal);
  proxy.connections.add(morse);
  proxy.activeThreadId = 'thread-terminal';
  proxy.activeConnection = terminal;

  const handled = proxy.handleClientMessage(morse, JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'turn/start',
    params: { threadId: 'thread-terminal', input: [{ type: 'text', text: 'hi', text_elements: [] }] },
  }));

  assert.equal(handled, true);
  const response = JSON.parse(morse.sentTexts[0]);
  assert.equal(response.id, 7);
  assert.match(response.error.message, /not ready/);
});

test('proxy mirrors terminal approval requests to morse and routes morse responses back', () => {
  const proxy = new CodexWebSocketProxy();
  let terminalSent = null;
  const terminal = fakeConnection({
    morse: false,
    sendBackend: (message) => { terminalSent = message; },
  });
  const morse = fakeConnection({ morse: true });
  proxy.connections.add(terminal);
  proxy.connections.add(morse);

  const handled = proxy.handleServerMessage(terminal, JSON.stringify({
    jsonrpc: '2.0',
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: { command: 'npm test' },
  }), null);

  assert.equal(handled, false);
  const mirrored = JSON.parse(morse.sentTexts[0]);
  assert.equal(mirrored.method, 'item/commandExecution/requestApproval');
  assert.notEqual(mirrored.id, 'approval-1');

  const responseHandled = proxy.handleClientMessage(morse, JSON.stringify({
    jsonrpc: '2.0',
    id: mirrored.id,
    result: { decision: 'approved' },
  }));

  assert.equal(responseHandled, true);
  assert.deepEqual(JSON.parse(terminalSent), {
    jsonrpc: '2.0',
    id: 'approval-1',
    result: { decision: 'approved' },
  });
});

test('proxy drops stale approval responses after terminal connection closes', () => {
  const proxy = new CodexWebSocketProxy();
  let terminalSent = null;
  const terminal = fakeConnection({
    morse: false,
    sendBackend: (message) => { terminalSent = message; },
  });
  const morse = fakeConnection({ morse: true });
  proxy.connections.add(terminal);
  proxy.connections.add(morse);

  proxy.handleServerMessage(terminal, JSON.stringify({
    jsonrpc: '2.0',
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: { command: 'npm test' },
  }), null);
  const mirrored = JSON.parse(morse.sentTexts[0]);
  terminal.closed = true;

  const handled = proxy.handleClientMessage(morse, JSON.stringify({
    jsonrpc: '2.0',
    id: mirrored.id,
    result: { decision: 'approved' },
  }));

  assert.equal(handled, true);
  assert.equal(terminalSent, null);
});

function fakeConnection({ morse, sendBackend = () => {} }) {
  return {
    backendOpen: true,
    closed: false,
    sentTexts: [],
    backend: { send: sendBackend },
    sendText(message) {
      this.sentTexts.push(message);
    },
    isMorseClient() {
      return morse;
    },
  };
}
