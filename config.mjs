import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';

export function globalConfigPath() {
  if (process.env.MORSE_CONFIG) return resolve(process.env.MORSE_CONFIG);
  if (process.env.MORSE_HOME) return resolve(process.env.MORSE_HOME, 'config.json');
  if (process.platform === 'win32' && process.env.APPDATA) {
    return resolve(process.env.APPDATA, 'morse', 'config.json');
  }
  const base = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  return resolve(base, 'morse', 'config.json');
}

export function runtimeStatePath() {
  if (process.env.MORSE_STATE) return resolve(process.env.MORSE_STATE);
  return resolve(dirname(globalConfigPath()), 'state.json');
}

export function bridgeStatePath() {
  if (process.env.MORSE_BRIDGE_STATE) return resolve(process.env.MORSE_BRIDGE_STATE);
  return resolve(dirname(globalConfigPath()), 'bridge.json');
}

export function bridgeLogPath() {
  if (process.env.MORSE_BRIDGE_LOG) return resolve(process.env.MORSE_BRIDGE_LOG);
  return resolve(dirname(globalConfigPath()), 'bridge.log');
}

export function loadGlobalConfig(path = globalConfigPath()) {
  if (!existsSync(path)) return null;
  return readJson(path);
}

export function loadRuntimeState(path = runtimeStatePath()) {
  if (!existsSync(path)) return null;
  return readJson(path);
}

export function loadBridgeState(path = bridgeStatePath()) {
  if (!existsSync(path)) return null;
  return readJson(path);
}

export function saveGlobalConfig(config, path = globalConfigPath()) {
  return savePrivateJson(config, path);
}

export function saveRuntimeState(state, path = runtimeStatePath()) {
  return savePrivateJson(state, path);
}

export function saveBridgeState(state, path = bridgeStatePath()) {
  return savePrivateJson(state, path);
}

export function clearRuntimeState(expectedState = null, path = runtimeStatePath()) {
  if (!existsSync(path)) return;
  if (expectedState) {
    const current = loadRuntimeState(path);
    if (current?.appServerUrl !== expectedState.appServerUrl || current?.pid !== expectedState.pid) return;
  }
  rmSync(path, { force: true });
}

export function clearBridgeState(expectedState = null, path = bridgeStatePath()) {
  if (!existsSync(path)) return;
  if (expectedState) {
    const current = loadBridgeState(path);
    if (current?.pid !== expectedState.pid) return;
  }
  rmSync(path, { force: true });
}

function savePrivateJson(value, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

export function parseAllowedUserIds(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

export function workspaceFromCwd(cwd = process.cwd()) {
  const resolved = resolve(cwd);
  return {
    cwd: resolved,
    label: basename(resolved) || resolved,
    enabledAt: new Date().toISOString(),
  };
}

export function runtimeFromGlobalConfig(config, fallbackCwd = process.cwd()) {
  if (!config?.telegramBotToken || !config?.allowedUserIds?.length) return null;
  const activeWorkspace = config.activeWorkspace ?? workspaceFromCwd(fallbackCwd);
  return {
    source: 'global',
    token: config.telegramBotToken,
    allowedUserIds: config.allowedUserIds,
    allowedChatIds: config.allowedChatIds ?? [],
    codexCommand: normalizeCodexCommand(config.codexCommand),
    cwd: activeWorkspace.cwd,
    workspaceLabel: activeWorkspace.label ?? activeWorkspace.cwd,
    timeoutSeconds: Number(config.timeoutSeconds ?? 600) || 0,
    streamDebounceMs: Number(config.streamDebounceMs ?? 1200) || 1200,
    appServerUrl: config.appServerUrl ?? 'ws://127.0.0.1:17373',
    appServerCommand: config.appServerCommand ?? 'codex app-server --listen ws://127.0.0.1:17373',
  };
}

export function runtimeFromEnv(env = process.env, fallbackCwd = process.cwd()) {
  const allowedUserIds = parseAllowedUserIds(env.ALLOWED_USER_IDS);
  if (!env.TELEGRAM_BOT_TOKEN || !allowedUserIds.length) return null;
  const cwd = env.CODEX_CWD?.trim() || fallbackCwd;
  return {
    source: 'env',
    token: env.TELEGRAM_BOT_TOKEN,
    allowedUserIds,
    allowedChatIds: parseAllowedUserIds(env.ALLOWED_CHAT_IDS),
    codexCommand: normalizeCodexCommand(env.CODEX_CMD),
    cwd,
    workspaceLabel: basename(resolve(cwd)) || cwd,
    timeoutSeconds: Number(env.CODEX_TIMEOUT_SECONDS ?? 600) || 0,
    streamDebounceMs: Number(env.STREAM_DEBOUNCE_MS ?? 1200) || 1200,
    appServerUrl: env.CODEX_APP_SERVER_URL ?? 'ws://127.0.0.1:17373',
    appServerCommand: env.CODEX_APP_SERVER_CMD ?? 'codex app-server --listen ws://127.0.0.1:17373',
  };
}

export function normalizeCodexCommand(command) {
  const value = (command ?? 'codex resume --last').trim();
  return value === 'codex exec' ? 'codex resume --last' : value;
}

export function loadRuntimeConfig(env = process.env, fallbackCwd = process.cwd()) {
  return runtimeFromGlobalConfig(loadGlobalConfig(), fallbackCwd) ?? runtimeFromEnv(env, fallbackCwd);
}

export function enableWorkspace(cwd = process.cwd()) {
  const config = loadGlobalConfig();
  if (!config) throw new Error(`no morse config found. run "morse setup" first.`);
  config.activeWorkspace = workspaceFromCwd(cwd);
  const path = saveGlobalConfig(config);
  return { config, path };
}
