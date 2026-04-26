import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  enableWorkspace,
  globalConfigPath,
  loadGlobalConfig,
  normalizeCodexCommand,
  runtimeFromEnv,
  runtimeFromGlobalConfig,
  saveGlobalConfig,
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

test('saveGlobalConfig and loadGlobalConfig round trip config', () => {
  withMorseConfigPath((path) => {
    const config = {
      telegramBotToken: '1234567890:test',
      allowedUserIds: [42],
      activeWorkspace: { cwd: 'J:\\Projects\\morse', label: 'morse', enabledAt: 'now' },
    };
    saveGlobalConfig(config);
    assert.deepEqual(loadGlobalConfig(path), config);
  });
});

test('runtimeFromGlobalConfig uses active workspace and defaults', () => {
  const runtime = runtimeFromGlobalConfig({
    telegramBotToken: '1234567890:test',
    allowedUserIds: [42],
    activeWorkspace: { cwd: 'J:\\Projects\\morse', label: 'morse', enabledAt: 'now' },
  });
  assert.equal(runtime.source, 'global');
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
    CODEX_CMD: 'codex exec --fast',
    CODEX_CWD: 'J:\\Projects\\legacy',
  });
  assert.equal(runtime.source, 'env');
  assert.deepEqual(runtime.allowedUserIds, [42, 99]);
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
