import test from 'node:test';
import assert from 'node:assert/strict';
import { isServerNotification, observeClientMessage, observeServerMessage } from '../websocket_proxy.mjs';

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
