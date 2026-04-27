import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  argsAfterOptionalSeparator,
  codexArgsForRemote,
  commandSpawnSpec,
  formatCommandForLog,
  nextBackupPath,
  niceCut,
  parseCommandLine,
  resolveExecutable,
  splitTelegramText,
} from '../helpers.mjs';

test('parseCommandLine handles simple commands', () => {
  assert.deepEqual(parseCommandLine('codex exec'), ['codex', 'exec']);
});

test('parseCommandLine preserves quoted args', () => {
  assert.deepEqual(parseCommandLine('codex exec --model "gpt 5" --flag=\'two words\''), [
    'codex',
    'exec',
    '--model',
    'gpt 5',
    '--flag=two words',
  ]);
});

test('parseCommandLine keeps empty quoted args', () => {
  assert.deepEqual(parseCommandLine('cmd "" tail'), ['cmd', '', 'tail']);
});

test('parseCommandLine preserves Windows paths', () => {
  assert.deepEqual(parseCommandLine('"C:\\Program Files\\Codex\\codex.exe" exec'), [
    'C:\\Program Files\\Codex\\codex.exe',
    'exec',
  ]);
});

test('parseCommandLine rejects empty commands', () => {
  assert.throws(() => parseCommandLine('   '), /CODEX_CMD is empty/);
});

test('parseCommandLine rejects unmatched quotes', () => {
  assert.throws(() => parseCommandLine('codex exec "unterminated'), /unmatched " quote/);
});

test('splitTelegramText leaves short text alone', () => {
  assert.deepEqual(splitTelegramText('hello', 10), ['hello']);
});

test('splitTelegramText splits long unbroken text safely', () => {
  const chunks = splitTelegramText('x'.repeat(25), 10);
  assert.deepEqual(chunks, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  assert.ok(chunks.every((chunk) => chunk.length <= 10));
});

test('splitTelegramText prefers paragraph boundaries', () => {
  const text = `${'a'.repeat(6)}\n\n${'b'.repeat(20)}`;
  assert.deepEqual(splitTelegramText(text, 12), [`${'a'.repeat(6)}\n\n`, 'b'.repeat(12), 'b'.repeat(8)]);
});

test('niceCut prefers newline boundaries in the second half', () => {
  assert.equal(niceCut(`abcdef\n${'g'.repeat(10)}`, 10), 7);
});

test('nextBackupPath returns first available backup path', () => {
  const existing = new Set(['.env.bak', '.env.bak.1']);
  assert.equal(nextBackupPath('.env', (path) => existing.has(path)), '.env.bak.2');
});

test('resolveExecutable returns path-like commands unchanged', () => {
  assert.equal(resolveExecutable('C:\\Tools\\codex.exe', {}, 'win32'), 'C:\\Tools\\codex.exe');
});

test('resolveExecutable finds commands on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'morse-path-'));
  try {
    const file = join(dir, 'codex.exe');
    writeFileSync(file, '');
    assert.equal(resolveExecutable('codex', { PATH: dir, PATHEXT: '.EXE' }, 'win32').toLowerCase(), file.toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commandSpawnSpec runs Unix-style executables without a shell', () => {
  const spec = commandSpawnSpec('/usr/local/bin/codex', ['--remote', 'ws://127.0.0.1:17373', '--resume'], {}, {}, 'linux');
  assert.equal(spec.command, '/usr/local/bin/codex');
  assert.deepEqual(spec.args, ['--remote', 'ws://127.0.0.1:17373', '--resume']);
  assert.equal(spec.options.shell, false);
});

test('commandSpawnSpec runs Windows exe files without a shell', () => {
  const spec = commandSpawnSpec('C:\\Tools\\codex.exe', ['--remote', 'ws://127.0.0.1:17373'], {}, {}, 'win32');
  assert.equal(spec.command, 'C:\\Tools\\codex.exe');
  assert.deepEqual(spec.args, ['--remote', 'ws://127.0.0.1:17373']);
  assert.equal(spec.options.shell, false);
});

test('commandSpawnSpec runs Windows cmd shims through cmd.exe', () => {
  const spec = commandSpawnSpec(
    'C:\\Tools\\codex.cmd',
    ['--remote', 'ws://127.0.0.1:17373', '--resume'],
    {},
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    'win32',
  );
  assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spec.args, ['/d', '/s', '/c', 'C:\\Tools\\codex.cmd --remote ws://127.0.0.1:17373 --resume']);
  assert.equal(spec.options.shell, false);
});

test('commandSpawnSpec ignores untrusted COMSPEC for Windows cmd shims', () => {
  const spec = commandSpawnSpec(
    'C:\\Tools\\codex.cmd',
    [],
    {},
    { ComSpec: 'C:\\repo\\cmd.exe', SystemRoot: 'D:\\Windows' },
    'win32',
  );
  assert.equal(spec.command, 'D:\\Windows\\System32\\cmd.exe');
});

test('commandSpawnSpec quotes Windows cmd shim paths and args with spaces', () => {
  const spec = commandSpawnSpec(
    'C:\\Program Files\\Codex\\codex.cmd',
    ['alpha beta', '--resume'],
    {},
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    'win32',
  );
  assert.equal(spec.args[3], '"C:\\Program Files\\Codex\\codex.cmd" "alpha beta" --resume');
});

test('formatCommandForLog quotes whitespace args', () => {
  assert.equal(formatCommandForLog('codex', ['--remote', 'ws://x', '--model', 'gpt 5']), 'codex --remote ws://x --model "gpt 5"');
});

test('argsAfterOptionalSeparator supports direct and -- pass-through', () => {
  assert.deepEqual(argsAfterOptionalSeparator(['node', 'bot.mjs', 'codex', '--resume'], 3), ['--resume']);
  assert.deepEqual(argsAfterOptionalSeparator(['node', 'bot.mjs', 'codex', '--', '--resume'], 3), ['--resume']);
});

test('codexArgsForRemote defaults to a fresh interactive session in the current cwd', () => {
  assert.deepEqual(codexArgsForRemote('ws://127.0.0.1:1234', []), [
    '--remote',
    'ws://127.0.0.1:1234',
  ]);
});

test('codexArgsForRemote maps --resume alias to resume --last', () => {
  assert.deepEqual(codexArgsForRemote('ws://127.0.0.1:1234', ['--model', 'gpt-5.2', '--resume']), [
    '--remote',
    'ws://127.0.0.1:1234',
    '--model',
    'gpt-5.2',
    'resume',
    '--last',
  ]);
});

test('codexArgsForRemote preserves explicit commands and prompts', () => {
  assert.deepEqual(codexArgsForRemote('ws://127.0.0.1:1234', ['resume', 'abc']), [
    '--remote',
    'ws://127.0.0.1:1234',
    'resume',
    'abc',
  ]);
  assert.deepEqual(codexArgsForRemote('ws://127.0.0.1:1234', ['hello codex']), [
    '--remote',
    'ws://127.0.0.1:1234',
    'hello codex',
  ]);
  assert.deepEqual(codexArgsForRemote('ws://127.0.0.1:1234', ['--model', 'gpt-5.2']), [
    '--remote',
    'ws://127.0.0.1:1234',
    '--model',
    'gpt-5.2',
  ]);
});
