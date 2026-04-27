import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionForChat,
  loadSessionRegistry,
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
