import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionForChat,
  pruneDeadSessions,
  sessionsByRecent,
  setChatActiveSession,
  upsertSession,
} from '../session_state.mjs';

function withMorseConfigPath(fn) {
  const previous = process.env.MORSE_CONFIG;
  const dir = mkdtempSync(join(tmpdir(), 'morse-stress-'));
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

test('stress: dead sessions are pruned while newest live session remains routable', () => {
  withMorseConfigPath(() => {
    const livePids = new Set();
    for (let i = 0; i < 30; i += 1) {
      const live = i % 4 === 0;
      const pid = 1000 + i;
      if (live) livePids.add(pid);
      upsertSession({
        id: `s${String(i).padStart(2, '0')}`,
        label: `repo-${i}`,
        pid,
        activeThreadId: `thread-${i}`,
        updatedAt: new Date(Date.UTC(2026, 3, 27, 1, i, 0)).toISOString(),
      });
    }
    setChatActiveSession(123, 's29');

    const { registry, removed } = pruneDeadSessions((pid) => livePids.has(pid));

    assert.equal(removed.length, 22);
    assert.deepEqual(sessionsByRecent(registry).map((session) => session.id), [
      's28',
      's24',
      's20',
      's16',
      's12',
      's08',
      's04',
      's00',
    ]);
    assert.equal(activeSessionForChat(123, registry).id, 's28');
  });
});

test('stress: queued work keeps the session selected at enqueue time', () => {
  withMorseConfigPath(() => {
    upsertSession({ id: 'a', label: 'repo-a', updatedAt: '2026-04-27T01:00:00.000Z' });
    upsertSession({ id: 'b', label: 'repo-b', updatedAt: '2026-04-27T02:00:00.000Z' });
    setChatActiveSession(123, 'a');

    const queued = [
      { text: 'first', sessionId: activeSessionForChat(123).id },
    ];
    setChatActiveSession(123, 'b');
    queued.push({ text: 'second', sessionId: activeSessionForChat(123).id });

    assert.deepEqual(queued, [
      { text: 'first', sessionId: 'a' },
      { text: 'second', sessionId: 'b' },
    ]);
  });
});
