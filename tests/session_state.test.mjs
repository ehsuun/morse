import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionForChat,
  loadSessionRegistry,
  pruneDeadSessions,
  pruneSessions,
  removeSession,
  sessionsByRecent,
  setChatActiveSession,
  upsertSession,
} from '../session_state.mjs';

function withMorseConfigPath(fn) {
  const previous = process.env.MORSE_CONFIG;
  const dir = mkdtempSync(join(tmpdir(), 'morse-test-'));
  process.env.MORSE_CONFIG = join(dir, 'config.json');
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.MORSE_CONFIG;
    } else {
      process.env.MORSE_CONFIG = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upsertSession stores and updates sessions', () => {
  withMorseConfigPath(() => {
    upsertSession({ id: 'abc12345', label: 'morse', startedAt: '2026-04-27T01:00:00.000Z' }, '2026-04-27T01:01:00.000Z');
    upsertSession({ id: 'abc12345', activeThreadId: 'thread-1' }, '2026-04-27T01:02:00.000Z');

    assert.deepEqual(loadSessionRegistry().sessions, [{
      id: 'abc12345',
      label: 'morse',
      startedAt: '2026-04-27T01:00:00.000Z',
      updatedAt: '2026-04-27T01:02:00.000Z',
      activeThreadId: 'thread-1',
    }]);
  });
});

test('activeSessionForChat uses explicit selection then newest session', () => {
  withMorseConfigPath(() => {
    upsertSession({ id: 'old', label: 'old', updatedAt: '2026-04-27T01:00:00.000Z' });
    upsertSession({ id: 'new', label: 'new', updatedAt: '2026-04-27T02:00:00.000Z' });

    assert.equal(activeSessionForChat(123).id, 'new');
    assert.equal(setChatActiveSession(123, 'old').id, 'old');
    assert.equal(activeSessionForChat(123).id, 'old');
  });
});

test('sessionsByRecent prefers active thread updates', () => {
  withMorseConfigPath(() => {
    upsertSession({
      id: 'a',
      updatedAt: '2026-04-27T03:00:00.000Z',
      activeThreadUpdatedAt: '2026-04-27T01:00:00.000Z',
    });
    upsertSession({
      id: 'b',
      updatedAt: '2026-04-27T02:00:00.000Z',
      activeThreadUpdatedAt: '2026-04-27T04:00:00.000Z',
    });

    assert.deepEqual(sessionsByRecent().map((session) => session.id), ['b', 'a']);
  });
});

test('removeSession and pruneSessions clear chat selections', () => {
  withMorseConfigPath(() => {
    upsertSession({ id: 'keep', updatedAt: '2026-04-27T01:00:00.000Z' });
    upsertSession({ id: 'drop', updatedAt: '2026-04-27T02:00:00.000Z' });
    setChatActiveSession(123, 'drop');

    pruneSessions((session) => session.id !== 'drop');
    assert.equal(activeSessionForChat(123).id, 'keep');

    removeSession('keep');
    assert.equal(activeSessionForChat(123), null);
  });
});

test('pruneDeadSessions removes dead pid sessions and clears active chat selections', () => {
  withMorseConfigPath(() => {
    upsertSession({ id: 'alive', pid: 111, updatedAt: '2026-04-27T01:00:00.000Z' });
    upsertSession({ id: 'dead', pid: 222, updatedAt: '2026-04-27T02:00:00.000Z' });
    setChatActiveSession(123, 'dead');

    const { registry, removed } = pruneDeadSessions((pid) => pid === 111);

    assert.deepEqual(removed.map((session) => session.id), ['dead']);
    assert.deepEqual(registry.sessions.map((session) => session.id), ['alive']);
    assert.equal(activeSessionForChat(123).id, 'alive');
  });
});

test('pruneDeadSessions keeps sessions without pids for compatibility', () => {
  withMorseConfigPath(() => {
    upsertSession({ id: 'legacy', updatedAt: '2026-04-27T01:00:00.000Z' });

    const { registry, removed } = pruneDeadSessions(() => false);

    assert.deepEqual(removed, []);
    assert.deepEqual(registry.sessions.map((session) => session.id), ['legacy']);
  });
});
