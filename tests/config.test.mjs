import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  bridgeLogPath,
  bridgeStatePath,
  clearBridgeState,
  clearRuntimeState,
  enableWorkspace,
  globalConfigPath,
  loadBridgeState,
  loadGlobalConfig,
  loadRuntimeState,
  loadSessionsState,
  normalizeCodexCommand,
  runtimeFromEnv,
  runtimeFromGlobalConfig,
  runtimeStatePath,
  saveSessionsState,
  saveBridgeState,
  saveGlobalConfig,
  saveRuntimeState,
  sessionsStatePath,
} from '../config.mjs';

function withMorseConfigPath(fn) {
  const previous = process.env.MORSE_CONFIG;
  const dir = mkdtempSync(join(tmpdir(), 'morse-test-'));
  process.env.MORSE_CONFIG = join(dir, 'config.json');
  try {
    return fn(process.env.MORSE_CONFIG);
  } finally {
    if (previous === undefined) {
      delete process.env.MORSE_CONFIG;
    } else {
      process.env.MORSE_CONFIG = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('globalConfigPath honors MORSE_CONFIG', () => {
  withMorseConfigPath((path) => {
    assert.equal(globalConfigPath(), resolve(path));
  });
});

test('runtimeStatePath lives next to MORSE_CONFIG by default', () => {
  withMorseConfigPath((path) => {
    assert.equal(runtimeStatePath(), resolve(path, '..', 'state.json'));
  });
});

test('bridge paths live next to MORSE_CONFIG by default', () => {
  withMorseConfigPath((path) => {
    assert.equal(bridgeStatePath(), resolve(path, '..', 'bridge.json'));
    assert.equal(bridgeLogPath(), resolve(path, '..', 'bridge.log'));
  });
});

test('sessionsStatePath lives next to MORSE_CONFIG by default', () => {
  withMorseConfigPath((path) => {
    assert.equal(sessionsStatePath(), resolve(path, '..', 'sessions.json'));
  });
});

test('saveGlobalConfig and loadGlobalConfig round trip config', () => {
  withMorseConfigPath((path) => {
    const config = {
      telegramBotToken: '1234567890:test',
      allowedUserIds: [42],
      allowedChatIds: [123],
      activeWorkspace: { cwd: 'J:\\Projects\\morse', label: 'morse', enabledAt: 'now' },
    };
    saveGlobalConfig(config);
    assert.deepEqual(loadGlobalConfig(path), config);
  });
});

test('loadGlobalConfig accepts UTF-8 BOM files', () => {
  withMorseConfigPath((path) => {
    const config = {
      telegramBotToken: '1234567890:test',
      allowedUserIds: [42],
      activeWorkspace: { cwd: 'J:\\Projects\\morse', label: 'morse', enabledAt: 'now' },
    };
    writeFileSync(path, `\uFEFF${JSON.stringify(config)}`, 'utf8');
    assert.deepEqual(loadGlobalConfig(path), config);
  });
});

test('saveRuntimeState and clearRuntimeState manage private session state', () => {
  withMorseConfigPath(() => {
    const state = {
      appServerUrl: 'ws://127.0.0.1:49152',
      appServerCommand: 'codex app-server --listen ws://127.0.0.1:49152',
      pid: 123,
    };
    saveRuntimeState(state);
    assert.deepEqual(loadRuntimeState(), state);
    clearRuntimeState({ ...state, pid: 456 });
    assert.deepEqual(loadRuntimeState(), state);
    clearRuntimeState(state);
    assert.equal(loadRuntimeState(), null);
  });
});

test('saveBridgeState and clearBridgeState manage private bridge state', () => {
  withMorseConfigPath(() => {
    const state = {
      pid: 123,
      startedAt: 'now',
      logPath: 'bridge.log',
    };
    saveBridgeState(state);
    assert.deepEqual(loadBridgeState(), state);
    clearBridgeState({ ...state, pid: 456 });
    assert.deepEqual(loadBridgeState(), state);
    clearBridgeState(state);
    assert.equal(loadBridgeState(), null);
  });
});

test('saveSessionsState and loadSessionsState round trip session registry', () => {
  withMorseConfigPath(() => {
    const state = {
      sessions: [{ id: 'abc12345', label: 'morse' }],
      chats: { 123: { activeSessionId: 'abc12345' } },
    };
    saveSessionsState(state);
    assert.deepEqual(loadSessionsState(), state);
  });
});

test('saveGlobalConfig tightens existing config permissions on POSIX', { skip: process.platform === 'win32' }, () => {
  withMorseConfigPath((path) => {
    writeFileSync(path, '{}', { mode: 0o666 });
    chmodSync(path, 0o644);
    saveGlobalConfig({
      telegramBotToken: '1234567890:test',
      allowedUserIds: [42],
      activeWorkspace: { cwd: 'J:\\Projects\\morse', label: 'morse', enabledAt: 'now' },
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test('runtimeFromGlobalConfig uses active workspace and defaults', () => {
  const runtime = runtimeFromGlobalConfig({
    telegramBotToken: '1234567890:test',
    allowedUserIds: [42],
    allowedChatIds: [123],
    activeWorkspace: { cwd: 'J:\\Projects\\morse', label: 'morse', enabledAt: 'now' },
  });
  assert.equal(runtime.source, 'global');
  assert.deepEqual(runtime.allowedChatIds, [123]);
  assert.equal(runtime.codexCommand, 'codex resume --last');
  assert.equal(runtime.appServerUrl, 'ws://127.0.0.1:17373');
  assert.equal(runtime.appServerCommand, 'codex app-server --listen ws://127.0.0.1:17373');
  assert.equal(runtime.cwd, 'J:\\Projects\\morse');
  assert.equal(runtime.workspaceLabel, 'morse');
});

test('runtimeFromEnv preserves legacy .env support', () => {
  const runtime = runtimeFromEnv({
    TELEGRAM_BOT_TOKEN: '1234567890:test',
    ALLOWED_USER_IDS: '42, 99',
    ALLOWED_CHAT_IDS: '123, 456',
    CODEX_CMD: 'codex exec --fast',
    CODEX_CWD: 'J:\\Projects\\legacy',
  });
  assert.equal(runtime.source, 'env');
  assert.deepEqual(runtime.allowedUserIds, [42, 99]);
  assert.deepEqual(runtime.allowedChatIds, [123, 456]);
  assert.equal(runtime.codexCommand, 'codex exec --fast');
  assert.equal(runtime.cwd, 'J:\\Projects\\legacy');
});

test('normalizeCodexCommand upgrades the old default exec command', () => {
  assert.equal(normalizeCodexCommand('codex exec'), 'codex resume --last');
  assert.equal(normalizeCodexCommand('codex exec --fast'), 'codex exec --fast');
});

test('enableWorkspace updates the global active workspace', () => {
  withMorseConfigPath(() => {
    saveGlobalConfig({
      telegramBotToken: '1234567890:test',
      allowedUserIds: [42],
      activeWorkspace: { cwd: 'old', label: 'old', enabledAt: 'old' },
    });
    const { config } = enableWorkspace('J:\\Projects\\new-app');
    assert.equal(config.activeWorkspace.cwd, 'J:\\Projects\\new-app');
    assert.equal(config.activeWorkspace.label, 'new-app');
    assert.match(config.activeWorkspace.enabledAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
