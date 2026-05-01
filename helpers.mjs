import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';

export const TELEGRAM_LIMIT = 4000;

export function parseCommandLine(input) {
  const text = input.trim();
  if (!text) throw new Error('CODEX_CMD is empty');

  const args = [];
  let current = '';
  let quote = null;
  let tokenStarted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        tokenStarted = true;
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length && ['"', '\\'].includes(text[i + 1])) {
        current += text[++i];
        tokenStarted = true;
      } else {
        current += ch;
        tokenStarted = true;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
    } else if (/\s/.test(ch)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
    } else {
      current += ch;
      tokenStarted = true;
    }
  }

  if (quote) throw new Error(`CODEX_CMD has an unmatched ${quote} quote`);
  if (tokenStarted) args.push(current);
  return args;
}

export function splitTelegramText(text, limit = TELEGRAM_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  if (!text) return [];

  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = niceCut(rest, limit);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function niceCut(text, limit = TELEGRAM_LIMIT) {
  const slice = text.slice(0, limit);
  const para = slice.lastIndexOf('\n\n');
  if (para > limit * 0.5) return para + 2;
  const nl = slice.lastIndexOf('\n');
  if (nl > limit * 0.5) return nl + 1;
  return limit;
}

export function nextBackupPath(path, exists) {
  const first = `${path}.bak`;
  if (!exists(first)) return first;

  for (let i = 1; ; i++) {
    const candidate = `${first}.${i}`;
    if (!exists(candidate)) return candidate;
  }
}

export function resolveExecutable(bin, env = process.env, platform = process.platform) {
  if (!bin) return null;
  if (isPathLike(bin)) return bin;

  const fromPath = resolveFromPath(bin, env, platform);
  if (fromPath) return fromPath;

  if (platform === 'win32' && bin.toLowerCase() === 'codex') {
    return findWindowsCodex(env);
  }

  return null;
}

export function spawnCommand(bin, args = [], options = {}, env = process.env, platform = process.platform) {
  const spec = commandSpawnSpec(bin, args, options, env, platform);
  return spawn(spec.command, spec.args, spec.options);
}

export function commandSpawnSpec(bin, args = [], options = {}, env = process.env, platform = process.platform) {
  if (!Array.isArray(args)) throw new Error('args must be an array');

  const baseOptions = { ...options, shell: false };
  if (platform === 'win32' && isWindowsCommandShim(bin)) {
    return {
      command: windowsCmdPath(env),
      args: ['/d', '/s', '/c', quoteWindowsCmdLine([bin, ...args])],
      options: baseOptions,
    };
  }

  return { command: bin, args, options: baseOptions };
}

export function formatCommandForLog(bin, args = []) {
  return [bin, ...args].map(quoteDisplayArg).join(' ');
}

export function argsAfterOptionalSeparator(argv, startIndex) {
  const args = argv.slice(startIndex);
  return args[0] === '--' ? args.slice(1) : args;
}

export function codexArgsForRemote(remoteUrl, rawArgs) {
  const args = rawArgs.filter((arg) => arg !== '--resume');
  const hadResumeAlias = args.length !== rawArgs.length;
  if (hadResumeAlias) return ['--remote', remoteUrl, ...args, 'resume', '--last'];
  return ['--remote', remoteUrl, ...args];
}

export function isTelegramNoopEditError(method, description) {
  return method.startsWith('editMessage')
    && /message is not modified/i.test(String(description ?? ''));
}

function resolveFromPath(bin, env, platform) {
  const pathValue = env.PATH || env.Path || '';
  const pathExts = platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const names = hasExecutableExtension(bin, pathExts) ? [bin] : pathExts.map((ext) => `${bin}${ext}`);

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findWindowsCodex(env) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;

  const packages = resolve(localAppData, 'Packages');
  if (!existsSync(packages)) return null;

  let names;
  try {
    names = readdirSync(packages);
  } catch {
    return null;
  }

  for (const name of names) {
    if (!name.startsWith('OpenAI.Codex_')) continue;
    const candidate = resolve(packages, name, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isPathLike(bin) {
  return isAbsolute(bin) || bin.includes('/') || bin.includes('\\') || dirname(bin) !== '.';
}

function hasExecutableExtension(bin, pathExts) {
  const lower = bin.toLowerCase();
  return pathExts.some((ext) => lower.endsWith(ext.toLowerCase()));
}

function isWindowsCommandShim(bin) {
  return /\.(?:cmd|bat)$/i.test(String(bin));
}

function windowsCmdPath(env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || '';
  if (/^[a-z]:\\windows$/i.test(systemRoot)) return `${systemRoot}\\System32\\cmd.exe`;
  return 'C:\\Windows\\System32\\cmd.exe';
}

function quoteWindowsCmdLine(args) {
  return args.map(quoteWindowsCmdArg).join(' ');
}

function quoteWindowsCmdArg(arg) {
  const value = String(arg);
  if (value === '') return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(["&|<>^])/g, '^$1')}"`;
}

function quoteDisplayArg(arg) {
  const value = String(arg);
  if (value === '') return '""';
  if (!/\s/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}
