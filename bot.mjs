#!/usr/bin/env node
// Minimal Telegram <-> Codex CLI bridge.
// Zero npm deps. Long-polls Telegram, relays each authorized message into the
// active repo's Codex thread, and streams stdout back.

import { closeSync, mkdirSync, openSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runSetup } from './setup.mjs';
import { approvalActionLabel, approvalKeyboard, approvalMessage, approvalResponse } from './approvals.mjs';
import {
  TELEGRAM_LIMIT,
  argsAfterOptionalSeparator,
  codexArgsForRemote,
  formatCommandForLog,
  isTelegramNoopEditError,
  resolveExecutable,
  spawnCommand,
  splitTelegramText,
} from './helpers.mjs';
import {
  bridgeLogPath,
  bridgeStatePath,
  clearBridgeState,
  clearRuntimeState,
  enableWorkspace,
  globalConfigPath,
  loadBridgeState,
  loadGlobalConfig,
  loadRuntimeConfig,
  loadRuntimeState,
  runtimeStatePath,
  saveBridgeState,
  saveRuntimeState,
} from './config.mjs';
import { CodexAppServer, turnInputFromTextAndAttachments } from './codex_app_server.mjs';
import { packageVersion } from './package_info.mjs';
import {
  isSlashPaletteRequest,
  modelChoiceById,
  modelChoiceKeyboard,
  modelChoiceMessage,
  slashCommandById,
  slashCommandKeyboard,
  slashCommandMessage,
} from './slash_commands.mjs';
import {
  activeSessionForChat,
  loadSessionRegistry,
  pruneDeadSessions,
  removeSession,
  sessionsByRecent,
  setChatActiveSession,
  sessionById,
  upsertSession,
} from './session_state.mjs';
import { authorizeTelegramPeer } from './telegram_auth.mjs';
import { CodexWebSocketProxy } from './websocket_proxy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, '.env');
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const APPROVAL_SEND_RETRIES = 3;

let runtime;
let API;
let codexServer;

// This bot is built for one private control thread. Keep one Codex relay active.
let activeRun = null;
let nextRunId = 1;
let nextApprovalId = 1;
let lastChatId = null;
const pendingApprovals = new Map();
const promptSessions = new Map();
const queuedRuns = [];
let queueDraining = false;
const loggedDeadSessionIds = new Set();

await main();

async function main() {
  const command = process.argv[2] ?? 'start';
  if (command === 'setup') {
    await runSetup();
  } else if (command === 'start') {
    if (process.argv.includes('--foreground')) {
      await startBot();
    } else {
      await startBridgeBackground({ announce: true });
    }
  } else if (command === 'stop') {
    stopBridge();
  } else if (command === 'enable') {
    enableCurrentWorkspace();
  } else if (command === 'codex') {
    await openRemoteCodex();
  } else if (command === 'status') {
    showStatus();
  } else if (command === 'version' || command === '--version' || command === '-v') {
    console.log(packageVersion());
  } else if (command === 'help' || command === '--help' || command === '-h') {
    console.log(cliHelpText());
  } else {
    console.error(`unknown command: ${command}`);
    console.error(cliHelpText());
    process.exitCode = 1;
  }
}

async function openRemoteCodex() {
  let config;
  try {
    ({ config } = enableWorkspace(process.cwd()));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  await ensureBridgeBackground();

  const remoteUrl = await createLoopbackRemoteUrl();
  let proxyUrl = await createLoopbackRemoteUrl();
  while (proxyUrl === remoteUrl) proxyUrl = await createLoopbackRemoteUrl();
  const appServerCommand = `codex app-server --listen ${remoteUrl}`;
  const server = new CodexAppServer({
    command: appServerCommand,
    url: remoteUrl,
    cwd: process.cwd(),
  });
  server.on('stderr', (chunk) => console.error(String(chunk).trimEnd()));
  server.on('fatal', (err) => console.error('codex app-server error', err.message));
  const proxy = new CodexWebSocketProxy({ listenUrl: proxyUrl, targetUrl: remoteUrl });
  proxy.on('error', (err) => console.error('codex remote proxy error', err.message));

  console.log(`morse enabled for ${config.activeWorkspace.label}`);
  console.log(`starting Codex app-server: ${remoteUrl}`);
  console.log(`starting terminal proxy: ${proxyUrl}`);
  try {
    await server.start();
  } catch (err) {
    server.stop();
    console.error(`could not start Codex remote: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    await proxy.start();
  } catch (err) {
    server.stop();
    console.error(`could not start Codex remote proxy: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const sessionId = createSessionId();
  const state = {
    id: sessionId,
    appServerUrl: remoteUrl,
    appServerCommand,
    proxyUrl,
    pid: server.child?.pid,
    cwd: process.cwd(),
    label: config.activeWorkspace.label,
    workspaceLabel: config.activeWorkspace.label,
    startedAt: new Date().toISOString(),
  };
  proxy.on('active-thread', (threadId) => {
    if (state.activeThreadId === threadId) return;
    state.activeThreadId = threadId;
    state.activeThreadUpdatedAt = new Date().toISOString();
    state.updatedAt = state.activeThreadUpdatedAt;
    saveRuntimeState(state);
    upsertSession(state);
  });
  const statePath = saveRuntimeState(state);
  upsertSession(state);
  console.log(`session: ${statePath}`);
  console.log(`session_id: ${sessionId}`);

  const codexArgs = argsAfterOptionalSeparator(process.argv, 3);
  const args = codexArgsForRemote(proxyUrl, codexArgs);
  const resolved = resolveExecutable('codex') ?? 'codex';

  console.log(`starting: ${formatCommandForLog('codex', args)}`);

  try {
    const child = spawnCommand(resolved, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    await new Promise((resolve) => {
      child.on('error', (err) => {
        console.error(formatRunError(err));
        process.exitCode = 1;
        resolve();
      });
      child.on('close', (code) => {
        process.exitCode = code ?? 0;
        resolve();
      });
    });
  } finally {
    clearRuntimeState(state);
    removeSession(sessionId);
    proxy.close();
    server.stop();
  }
}

async function startBot() {
  const existing = loadLiveBridgeState();
  if (existing && existing.pid !== process.pid) {
    console.log(`morse is up and running (pid ${existing.pid})`);
    if (existing.logPath) console.log(`log: ${existing.logPath}`);
    return;
  }

  runtime = await ensureConfigured();
  API = `${telegramApiBaseUrl()}/bot${runtime.token}`;
  const bridgeState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    logPath: process.env.MORSE_BRIDGE_LOG || null,
  };
  saveBridgeState(bridgeState);
  installBridgeStateCleanup(bridgeState);

  console.log(`morse ready. allowed=${runtime.allowedUserIds.join(',')} cwd=${runtime.cwd}`);
  console.log(`active workspace: ${runtime.workspaceLabel}`);
  console.log(`session state: ${runtimeStatePath()}`);
  console.log('open a Codex session with `morse codex` before sending work from Telegram.');

  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50 });
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch((err) => console.error('handler error', err));
      }
    } catch (err) {
      console.error('poll error', err);
      await sleep(2000);
    }
  }
}

async function ensureBridgeBackground() {
  const bridge = loadLiveBridgeState();
  if (bridge) return bridge;
  return await startBridgeBackground({ announce: false });
}

async function startBridgeBackground({ announce }) {
  const existing = loadLiveBridgeState();
  if (existing) {
    if (announce) {
      console.log(`morse is up and running (pid ${existing.pid})`);
      console.log(`log: ${existing.logPath || bridgeLogPath()}`);
    }
    return existing;
  }

  const config = loadRuntimeConfig(process.env, process.cwd());
  if (!config) {
    console.error('no morse config found. run "morse setup" first.');
    process.exitCode = 1;
    return null;
  }

  const logPath = bridgeLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const out = openSync(logPath, 'a');
  let child;
  try {
    child = spawnCommand(process.execPath, [fileURLToPath(import.meta.url), 'start', '--foreground'], {
      cwd: HERE,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: {
        ...process.env,
        MORSE_BRIDGE_LOG: logPath,
      },
    });
  } finally {
    closeSync(out);
  }
  child.unref();

  const state = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath,
  };
  saveBridgeState(state);

  if (announce) {
    console.log(`morse is up and running (pid ${state.pid})`);
    console.log(`log: ${logPath}`);
  }
  return state;
}

function stopBridge() {
  const state = loadBridgeState();
  if (!state?.pid) {
    console.log('morse bridge is not running.');
    return;
  }
  if (!isProcessAlive(state.pid)) {
    clearBridgeState(state);
    console.log('morse bridge was not running. cleared stale state.');
    return;
  }
  try {
    process.kill(state.pid, 'SIGTERM');
    clearBridgeState(state);
    console.log(`stopped morse bridge (pid ${state.pid})`);
  } catch (err) {
    console.error(`could not stop morse bridge: ${err.message}`);
    process.exitCode = 1;
  }
}

function loadLiveBridgeState() {
  const state = loadBridgeState();
  if (!state?.pid) return null;
  if (isProcessAlive(state.pid)) return state;
  clearBridgeState(state);
  return null;
}

function installBridgeStateCleanup(state) {
  const cleanup = () => clearBridgeState(state);
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
}

async function ensureConfigured() {
  loadDotEnv(ENV_PATH);
  let config = loadRuntimeConfig(process.env, process.cwd());
  if (config) return config;
  console.log('no morse config found - running first-time setup.');
  await runSetup();
  loadDotEnv(ENV_PATH);
  config = loadRuntimeConfig(process.env, process.cwd());
  if (!config) {
    console.error('setup did not complete. exiting.');
    process.exit(1);
  }
  return config;
}

function enableCurrentWorkspace() {
  try {
    const { config, path } = enableWorkspace(process.cwd());
    console.log(`morse enabled for ${config.activeWorkspace.label}`);
    console.log(`cwd: ${config.activeWorkspace.cwd}`);
    console.log(`config: ${path}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

function showStatus() {
  loadDotEnv(ENV_PATH);
  const config = loadGlobalConfig();
  const current = loadRuntimeConfig(process.env, process.cwd());
  console.log(`config: ${globalConfigPath()}`);
  if (!current) {
    console.log('status: not set up');
    console.log('next: morse setup');
    return;
  }
  console.log(`status: configured (${current.source})`);
  console.log(`token: ${maskToken(current.token)}`);
  console.log(`allowed: ${current.allowedUserIds.join(',')}`);
  console.log(`active_project: ${current.workspaceLabel}`);
  console.log(`cwd: ${current.cwd}`);
  console.log(`session: ${runtimeStatePath()}`);
  const bridge = loadLiveBridgeState();
  if (bridge) {
    console.log(`bridge_status: running`);
    console.log(`bridge_pid: ${bridge.pid}`);
    if (bridge.logPath) console.log(`bridge_log: ${bridge.logPath}`);
  } else {
    console.log(`bridge_status: stopped`);
  }
  const state = loadLiveRuntimeState();
  if (state?.appServerUrl) {
    console.log('session_status: active');
    console.log(`codex_remote: codex --remote ${state.appServerUrl}`);
    if (state.proxyUrl) console.log(`codex_proxy: codex --remote ${state.proxyUrl}`);
    console.log(`terminal_thread: ${state.activeThreadId ?? 'not connected yet'}`);
  } else {
    console.log('session_status: none');
  }
  const registry = liveSessionRegistry();
  const sessions = sessionsByRecent(registry);
  console.log(`sessions: ${sessions.length}`);
  for (const session of sessions) {
    const parts = [
      `session ${session.id}`,
      `label=${sessionLabel(session)}`,
      `status=${session.status ?? 'unknown'}`,
      `pid=${session.pid ?? 'none'}`,
      `thread=${session.activeThreadId ?? 'none'}`,
      `cwd=${session.cwd ?? 'unknown'}`,
    ];
    if (session.waitingReason) parts.push(`waiting=${session.waitingReason}`);
    console.log(parts.join(' '));
  }
  if (config?.activeWorkspace?.enabledAt) console.log(`enabled_at: ${config.activeWorkspace.enabledAt}`);
}

function maskToken(token) {
  if (!token) return '(missing)';
  if (token.length <= 12) return '(set)';
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

function telegramApiBaseUrl() {
  return (process.env.MORSE_TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const auth = authorizeTelegramPeer(runtime, { userId, chatId, chatType: msg.chat.type });
  if (!auth.ok) {
    console.log(`ignored message from ${userId} (${msg.from?.username}): ${auth.reason}`);
    return;
  }
  lastChatId = chatId;

  const attachments = await attachmentsFromTelegramMessage(msg);
  const text = String(msg.text ?? msg.caption ?? '').trim();
  if (!text && !attachments.length) return;
  logSessionEvent('telegram_message', {
    chatId,
    userId,
    messageId: msg.message_id,
    text: text ? summarizeText(text) : null,
    attachments: attachments.length,
  });

  if (!attachments.length && (text === '/start' || text === '/help')) {
    await send(chatId, helpText());
    return;
  }
  if (!attachments.length && isSlashPaletteRequest(text)) {
    await send(chatId, slashCommandMessage(), {
      reply_markup: { inline_keyboard: slashCommandKeyboard() },
    });
    return;
  }
  if (!attachments.length && isTelegramCommand(text, '/sessions')) {
    await sendSessionsMessage(chatId);
    return;
  }
  if (!attachments.length && isTelegramCommand(text, '/approvals')) {
    await resendPendingApprovals(chatId);
    return;
  }
  if (!attachments.length && text === '/whoami') {
    const current = loadRuntimeConfig(process.env, process.cwd()) ?? runtime;
    await send(chatId, `user_id: ${userId}\nchat_id: ${chatId}\nactive_project: ${current.workspaceLabel}\ncwd: ${current.cwd}`);
    return;
  }
  if (!attachments.length && text === '/cancel') {
    if (activeRun) {
      codexServer.interrupt(activeRun.threadId, activeRun.turnId).catch((err) => console.error('interrupt error', err));
      await send(chatId, 'cancelling current request...');
    } else {
      await send(chatId, 'nothing running.');
    }
    return;
  }
  if (pendingApprovalsForChat(chatId).length) {
    await send(chatId, 'Codex is waiting for approval; resending the pending approval buttons instead of queueing this message.');
    await resendPendingApprovals(chatId, { announce: false });
    return;
  }

  const inputItems = attachments.length ? turnInputFromTextAndAttachments(text, attachments) : null;
  await enqueueRun(text, chatId, inputItems, sessionIdForPromptReply(msg));
}

async function enqueueRun(text, chatId, inputItems = null, sessionId = null) {
  const runId = nextRunId++;
  const queued = activeRun || queueDraining || queuedRuns.length > 0;
  const ack = await send(chatId, queued ? `queued (${queuedRuns.length + 1} ahead)` : 'working...');
  const registry = liveSessionRegistry();
  const session = sessionId ? sessionById(sessionId, registry) : activeSessionForChat(chatId, registry);
  queuedRuns.push({ id: runId, text, inputItems, chatId, sessionId: session?.id ?? null, ackMessageId: ack.message_id });
  logSessionEvent('run_queued', {
    runId,
    chatId,
    sessionId: session?.id ?? null,
    queuedAhead: queued ? queuedRuns.length - 1 : 0,
    text: summarizeText(text),
  });
  drainQueue().catch((err) => console.error('queue drain error', err));
}

async function drainQueue() {
  if (queueDraining) return;
  queueDraining = true;
  try {
    while (queuedRuns.length > 0) {
      const run = queuedRuns.shift();
      try {
        await runCodexStreaming(run.text, run.chatId, run.ackMessageId, run.id, run.inputItems, run.sessionId);
      } catch (err) {
        logSessionEvent('run_failed', {
          runId: run.id,
          chatId: run.chatId,
          sessionId: run.sessionId,
          error: formatRunError(err),
        });
        console.error(`run ${run.id} failed: ${formatRunError(err)}`);
        await tg('editMessageText', {
          chat_id: run.chatId,
          message_id: run.ackMessageId,
          text: `error: ${formatRunError(err)}`,
        });
      }
    }
  } finally {
    queueDraining = false;
  }
}

function formatRunError(err) {
  if (err?.code === 'ENOENT') {
    return [
      'could not find the Codex CLI.',
      'Install/open Codex so the `codex` command is available, or set `appServerCommand` in morse config to the full codex.exe app-server command.',
    ].join('\n');
  }
  return err?.message || String(err);
}

async function attachmentsFromTelegramMessage(msg) {
  const descriptors = [];
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const photo = msg.photo.at(-1);
    descriptors.push({
      type: 'localImage',
      fileId: photo.file_id,
      uniqueId: photo.file_unique_id,
      fallbackExt: '.jpg',
    });
  }
  if (msg.document?.mime_type?.startsWith('image/')) {
    descriptors.push({
      type: 'localImage',
      fileId: msg.document.file_id,
      uniqueId: msg.document.file_unique_id,
      fallbackExt: extname(msg.document.file_name ?? '') || mimeImageExtension(msg.document.mime_type),
    });
  }
  if (msg.voice) {
    descriptors.push({
      type: 'localFile',
      label: 'Telegram voice message',
      fileId: msg.voice.file_id,
      uniqueId: msg.voice.file_unique_id,
      fallbackExt: mimeAudioExtension(msg.voice.mime_type),
    });
  }
  if (msg.audio) {
    descriptors.push({
      type: 'localFile',
      label: 'Telegram audio file',
      fileId: msg.audio.file_id,
      uniqueId: msg.audio.file_unique_id,
      fallbackExt: extname(msg.audio.file_name ?? '') || mimeAudioExtension(msg.audio.mime_type),
    });
  }
  if (msg.document?.mime_type?.startsWith('audio/')) {
    descriptors.push({
      type: 'localFile',
      label: 'Telegram audio document',
      fileId: msg.document.file_id,
      uniqueId: msg.document.file_unique_id,
      fallbackExt: extname(msg.document.file_name ?? '') || mimeAudioExtension(msg.document.mime_type),
    });
  }

  const attachments = [];
  for (const descriptor of descriptors) {
    attachments.push({
      type: descriptor.type,
      label: descriptor.label,
      path: await downloadTelegramFile(descriptor),
    });
  }
  return attachments;
}

async function downloadTelegramFile({ fileId, uniqueId, fallbackExt = '.jpg' }) {
  const file = await tg('getFile', { file_id: fileId });
  if (!file.file_path) throw new Error('telegram getFile did not return a file path');
  const ext = extname(file.file_path ?? '') || fallbackExt || '.jpg';
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeFilePart(uniqueId || fileId)}${ext}`;
  const dir = resolve(dirname(globalConfigPath()), 'media');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, name);

  const res = await fetch(`https://api.telegram.org/file/bot${runtime.token}/${file.file_path}`);
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status} ${res.statusText}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
  return path;
}

function safeFilePart(value) {
  return String(value ?? 'file').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'file';
}

function mimeImageExtension(mimeType) {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  return '.jpg';
}

function mimeAudioExtension(mimeType) {
  if (mimeType === 'audio/mpeg') return '.mp3';
  if (mimeType === 'audio/mp4') return '.m4a';
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return '.wav';
  if (mimeType === 'audio/webm') return '.webm';
  return '.ogg';
}

async function runCodexStreaming(prompt, chatId, ackMessageId, runId, inputItems = null, sessionId = null) {
  const current = loadRuntimeConfig(process.env, process.cwd()) ?? runtime;
  const streamDebounceMs = current.streamDebounceMs;
  const state = await waitForActiveCodexThread(chatId, sessionId);
  const targetCwd = state.cwd ?? current.cwd;
  upsertSession({ ...state, status: 'running', waitingReason: null, waitingSince: null });
  const server = await ensureCodexServer(state);
  logSessionEvent('run_started', {
    runId,
    chatId,
    sessionId: state.id ?? sessionId,
    threadId: state.activeThreadId,
    cwd: targetCwd,
  });
  console.log(`run ${runId}: relaying to thread ${state.activeThreadId} cwd ${targetCwd} via ${state.proxyUrl ?? state.appServerUrl}`);

  let currentId = ackMessageId;
  let currentText = '';
  let lastEdited = '';
  let pending = null;

  const flush = async () => {
    pending = null;
    if (!currentText.trim()) return;

    const chunks = splitTelegramText(currentText, TELEGRAM_LIMIT);
    if (chunks.length === 1) {
      if (currentText !== lastEdited) {
        await tg('editMessageText', { chat_id: chatId, message_id: currentId, text: currentText });
        lastEdited = currentText;
      }
      return;
    }

    if (chunks[0] !== lastEdited) {
      await tg('editMessageText', { chat_id: chatId, message_id: currentId, text: chunks[0] });
    }
    for (const chunk of chunks.slice(1)) {
      const next = await send(chatId, chunk);
      currentId = next.message_id;
    }
    currentText = chunks.at(-1);
    lastEdited = currentText;
  };

  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => flush().catch((e) => console.error('flush error', e)), streamDebounceMs);
  };

  try {
    const result = await server.relayTurn({
      cwd: targetCwd,
      text: prompt,
      inputItems,
      threadId: state.activeThreadId,
      timeoutMs: current.timeoutSeconds > 0 ? current.timeoutSeconds * 1000 : 0,
      onStarted: ({ threadId, turnId }) => {
        activeRun = { id: runId, threadId, turnId, chatId, sessionId: state.id ?? sessionId };
      },
      onDelta: (delta) => {
        currentText += delta.replace(ANSI_RE, '');
        schedule();
      },
    });
  } finally {
    if (pending) clearTimeout(pending);
    if (activeRun?.id === runId) activeRun = null;
    upsertSession({ ...state, status: 'idle', waitingReason: null, waitingSince: null });
    logSessionEvent('run_finished', {
      runId,
      chatId,
      sessionId: state.id ?? sessionId,
      threadId: state.activeThreadId,
    });
  }
  await flush();

  if (!currentText.trim()) {
    await tg('editMessageText', { chat_id: chatId, message_id: currentId, text: '(no output)' });
  }
}

async function handleCodexRequest(request) {
  const chatId = activeRun?.chatId ?? lastChatId;
  if (!chatId) {
    codexServer.respondError(request.id, -32000, 'morse has no Telegram chat to request approval from');
    return;
  }
  const session = sessionForActiveRequest(chatId);

  if (!isApprovalRequest(request.method)) {
    if (session) setChatActiveSession(chatId, session.id);
    const message = await send(chatId, [
      session ? actionPromptMessage(session, true, 'input', request.method) : 'Codex requested unsupported client action.',
      !session ? request.method : null,
    ].filter(Boolean).join('\n'), session ? { reply_markup: { force_reply: true } } : {});
    if (session) promptSessions.set(promptSessionKey(chatId, message.message_id), session.id);
    codexServer.respondError(request.id, -32601, `unsupported request: ${request.method}`);
    return;
  }

  const previous = activeSessionForChat(chatId, loadSessionRegistry());
  const switched = session?.id && previous?.id !== session.id;
  if (session) {
    setChatActiveSession(chatId, session.id);
    upsertSession({
      ...session,
      status: 'waiting',
      waitingReason: 'approval',
      waitingSince: new Date().toISOString(),
    });
    logSessionEvent('approval_waiting', {
      chatId,
      sessionId: session.id,
      threadId: session.activeThreadId ?? null,
      method: request.method,
      switched: Boolean(switched),
    });
  }
  const approvalId = String(nextApprovalId++);
  const approval = {
    request,
    chatId,
    messageId: null,
    sessionId: session?.id ?? null,
    createdAt: Date.now(),
  };
  pendingApprovals.set(approvalId, approval);

  try {
    await deliverApprovalPrompt(approvalId, approval, { session, switched });
  } catch (err) {
    console.error(`could not send approval ${approvalId} to Telegram: ${err.message || err}`);
  }
}

async function waitForActiveCodexThread(chatId, sessionId = null, timeoutMs = 20000) {
  const started = Date.now();
  while (true) {
    const state = activeRuntimeStateForChat(chatId, sessionId);
    if (!state?.appServerUrl || !state?.appServerCommand) {
      throw new Error('no active Codex remote. Run `morse codex` from the repo first and keep it open.');
    }
    if (state.pid && !isProcessAlive(state.pid)) {
      clearRuntimeState(state);
      removeSession(state.id);
      logSessionEvent('session_dead', {
        sessionId: state.id ?? null,
        pid: state.pid,
        reason: 'wait_for_thread',
      });
      throw new Error('the active Codex remote is no longer running. Run `morse codex` again.');
    }
    if (state.activeThreadId) return state;
    if (Date.now() - started >= timeoutMs) {
      throw new Error('Codex terminal is not connected yet. Wait for `morse codex` to finish opening, then send the message again.');
    }
    await sleep(500);
  }
}

async function ensureCodexServer(state = loadLiveRuntimeState()) {
  if (!state?.appServerUrl || !state?.appServerCommand) {
    throw new Error('no active Codex remote. Run `morse codex` from the repo first and keep it open.');
  }
  if (state.pid && !isProcessAlive(state.pid)) {
    clearRuntimeState(state);
    removeSession(state.id);
    logSessionEvent('session_dead', {
      sessionId: state.id ?? null,
      pid: state.pid,
      reason: 'ensure_server',
    });
    throw new Error('the active Codex remote is no longer running. Run `morse codex` again.');
  }

  const relayUrl = state.proxyUrl ?? state.appServerUrl;
  if (codexServer?.url === relayUrl) return codexServer;

  if (codexServer) codexServer.stop();
  codexServer = new CodexAppServer({
    command: state.appServerCommand,
    url: relayUrl,
    cwd: state.cwd ?? runtime.cwd,
    allowReuse: true,
  });
  codexServer.on('stderr', (chunk) => console.error(String(chunk).trimEnd()));
  codexServer.on('fatal', (err) => console.error('codex app-server error', err.message));
  codexServer.on('request', (request) => handleCodexRequest(request).catch((err) => {
    console.error('codex request handler error', err);
    codexServer.respondError(request.id, -32000, err.message || String(err));
  }));
  await codexServer.start();
  return codexServer;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function activeRuntimeStateForChat(chatId, sessionId = null) {
  const registry = liveSessionRegistry();
  if (sessionId) return sessionById(sessionId, registry);
  return activeSessionForChat(chatId, registry) ?? loadLiveRuntimeState();
}

function liveSessionRegistry() {
  const { registry, removed } = pruneDeadSessions(isProcessAlive);
  for (const session of removed) {
    if (loggedDeadSessionIds.has(session.id)) continue;
    loggedDeadSessionIds.add(session.id);
    logSessionEvent('session_pruned', {
      sessionId: session.id,
      pid: session.pid,
      label: session.label ?? session.workspaceLabel ?? null,
      cwd: session.cwd ?? null,
    });
  }
  return registry;
}

function loadLiveRuntimeState() {
  const state = loadRuntimeState();
  if (!state?.pid || isProcessAlive(state.pid)) return state;
  clearRuntimeState(state);
  removeSession(state.id);
  logSessionEvent('session_dead', {
    sessionId: state.id ?? null,
    pid: state.pid,
    reason: 'runtime_state',
  });
  return null;
}

function createSessionId() {
  const existing = new Set(loadSessionRegistry().sessions.map((session) => session.id));
  for (let i = 0; i < 10; i += 1) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID().replace(/-/g, '');
}

function isTelegramCommand(text, expected) {
  const command = String(text ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase();
  return command?.split('@', 1)[0] === expected;
}

function sessionForActiveRequest(chatId) {
  const registry = liveSessionRegistry();
  if (activeRun?.sessionId) return sessionById(activeRun.sessionId, registry);
  return activeSessionForChat(chatId, registry);
}

function pendingApprovalsForChat(chatId) {
  return [...pendingApprovals.entries()].filter(([, approval]) => approval.chatId === chatId);
}

async function resendPendingApprovals(chatId, { announce = true } = {}) {
  const approvals = pendingApprovalsForChat(chatId);
  if (!approvals.length) {
    await send(chatId, 'no pending approvals.');
    return;
  }

  if (announce) await send(chatId, `resending ${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}...`);
  for (const [approvalId, approval] of approvals) {
    try {
      await deliverApprovalPrompt(approvalId, approval, { resend: true });
    } catch (err) {
      console.error(`could not resend approval ${approvalId}: ${err.message || err}`);
      await send(chatId, `could not resend approval ${approvalId}: ${err.message || String(err)}`);
    }
  }
}

async function deliverApprovalPrompt(approvalId, approval, { session = null, switched = false, resend = false } = {}) {
  const approvalSession = session ?? (approval.sessionId ? sessionById(approval.sessionId) : null);
  const keyboard = approvalKeyboard(approval.request.method).map((row) => row.map((button) => ({
    text: button.text,
    callback_data: `ap:${approvalId}:${button.callback_data}`,
  })));
  const body = [
    resend ? `Pending approval ${approvalId}` : null,
    actionPromptMessage(
      approvalSession,
      switched,
      'approval',
      approvalMessage(approval.request.method, approval.request.params),
    ),
  ].filter(Boolean).join('\n\n');

  const message = await sendWithRetry(approval.chatId, body, {
    reply_markup: { inline_keyboard: keyboard },
  }, { attempts: APPROVAL_SEND_RETRIES });
  approval.messageId = message.message_id;
  if (approvalSession) promptSessions.set(promptSessionKey(approval.chatId, message.message_id), approvalSession.id);
}

function promptSessionKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

function sessionIdForPromptReply(msg) {
  const repliedTo = msg.reply_to_message?.message_id;
  if (!repliedTo) return null;
  return promptSessions.get(promptSessionKey(msg.chat.id, repliedTo)) ?? null;
}

function actionPromptMessage(session, switched, kind, body) {
  if (!session) return body;
  return [
    `${sessionLabel(session)} needs ${kind}.`,
    switched ? `Switched active session to ${sessionLabel(session)}.` : `Active session: ${sessionLabel(session)}.`,
    '',
    body,
  ].join('\n');
}

async function handleCallbackQuery(query) {
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const chatType = query.message?.chat?.type;
  const auth = authorizeTelegramPeer(runtime, { userId, chatId, chatType });
  if (!auth.ok) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Not allowed.', show_alert: true });
    return;
  }

  const match = String(query.data ?? '').match(/^ap:([^:]+):(.+)$/);
  if (String(query.data ?? '').startsWith('cmd:')) {
    await handleSlashCommandCallback(query);
    return;
  }
  if (String(query.data ?? '').startsWith('model:')) {
    await handleModelChoiceCallback(query);
    return;
  }
  if (String(query.data ?? '').startsWith('sess:')) {
    await handleSessionChoiceCallback(query);
    return;
  }

  if (!match) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Unknown action.', show_alert: true });
    return;
  }

  const [, approvalId, action] = match;
  const approval = pendingApprovals.get(approvalId);
  if (!approval) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Approval expired.', show_alert: true });
    return;
  }

  pendingApprovals.delete(approvalId);
  if (approval.sessionId) {
    setChatActiveSession(approval.chatId, approval.sessionId);
    const session = sessionById(approval.sessionId);
    if (session) upsertSession({ ...session, status: 'running', waitingReason: null, waitingSince: null });
    promptSessions.delete(promptSessionKey(approval.chatId, approval.messageId));
  }
  const result = approvalResponse(approval.request.method, approval.request.params, action);
  codexServer.respond(approval.request.id, result);

  const label = approvalActionLabel(action);
  await tg('answerCallbackQuery', { callback_query_id: query.id, text: label });
  await tg('editMessageReplyMarkup', {
    chat_id: approval.chatId,
    message_id: approval.messageId,
    reply_markup: { inline_keyboard: [] },
  });
  await send(approval.chatId, `approval ${approvalId}: ${label}`);
}

async function handleSlashCommandCallback(query) {
  const id = String(query.data ?? '').slice('cmd:'.length);
  if (id === 'back') {
    if (!query.message?.chat?.id) {
      await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'No active chat.', show_alert: true });
      return;
    }
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Commands' });
    await tg('editMessageText', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: slashCommandMessage(),
      reply_markup: { inline_keyboard: slashCommandKeyboard() },
    });
    return;
  }

  const command = slashCommandById(id);
  if (!command) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Unknown command.', show_alert: true });
    return;
  }

  const chatId = query.message?.chat?.id;
  if (!chatId) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'No active chat.', show_alert: true });
    return;
  }

  lastChatId = chatId;
  if (command.submenu === 'model') {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Choose model' });
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: query.message.message_id,
      text: modelChoiceMessage(),
      reply_markup: { inline_keyboard: modelChoiceKeyboard() },
    });
    return;
  }

  await tg('answerCallbackQuery', { callback_query_id: query.id, text: `Queued ${command.command}` });
  await enqueueRun(command.command, chatId);
}

async function handleModelChoiceCallback(query) {
  const id = String(query.data ?? '').slice('model:'.length);
  const model = modelChoiceById(id);
  if (!model) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Unknown model.', show_alert: true });
    return;
  }

  const chatId = query.message?.chat?.id;
  if (!chatId) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'No active chat.', show_alert: true });
    return;
  }

  lastChatId = chatId;
  await tg('answerCallbackQuery', { callback_query_id: query.id, text: `Queued ${model.label}` });
  await enqueueRun(model.command, chatId);
}

async function sendSessionsMessage(chatId) {
  const registry = liveSessionRegistry();
  const keyboard = sessionChoiceKeyboard(registry, chatId);
  const extra = keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
  await send(chatId, sessionsMessage(registry, chatId), extra);
}

async function handleSessionChoiceCallback(query) {
  const sessionId = String(query.data ?? '').slice('sess:'.length);
  const chatId = query.message?.chat?.id;
  if (!chatId) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'No active chat.', show_alert: true });
    return;
  }

  const registry = liveSessionRegistry();
  const session = sessionById(sessionId, registry);
  if (!session) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Session not found.', show_alert: true });
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: query.message.message_id,
      text: sessionsMessage(registry, chatId),
      reply_markup: { inline_keyboard: sessionChoiceKeyboard(registry, chatId) },
    });
    return;
  }

  setChatActiveSession(chatId, session.id);
  const nextRegistry = loadSessionRegistry();
  logSessionEvent('session_selected', { chatId, sessionId: session.id, label: sessionLabel(session) });
  await tg('answerCallbackQuery', { callback_query_id: query.id, text: `Active: ${sessionLabel(session)}` });
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: query.message.message_id,
    text: sessionsMessage(nextRegistry, chatId),
    reply_markup: { inline_keyboard: sessionChoiceKeyboard(nextRegistry, chatId) },
  });
  await send(chatId, `Active session: ${sessionLabel(session)} (${session.id})`);
}

function sessionsMessage(registry, chatId) {
  const sessions = sessionsByRecent(registry);
  if (!sessions.length) return 'No active Codex sessions. Run `morse codex` from a repo first.';
  const active = activeSessionForChat(chatId, registry);
  return [
    'Codex sessions',
    '',
    ...sessions.map((session) => {
      const marker = session.id === active?.id ? '*' : ' ';
      return `${marker} ${sessionListLabel(session)} (${session.id})`;
    }),
  ].join('\n');
}

function sessionChoiceKeyboard(registry, chatId) {
  const active = activeSessionForChat(chatId, registry);
  return sessionsByRecent(registry).map((session) => [{
    text: `${session.id === active?.id ? '* ' : ''}${shortButtonLabel(sessionListLabel(session))} (${session.id})`,
    callback_data: `sess:${session.id}`,
  }]);
}

function shortButtonLabel(label) {
  return label.length > 40 ? `${label.slice(0, 37)}...` : label;
}

function sessionLabel(session) {
  return session.label ?? session.workspaceLabel ?? session.cwd ?? 'session';
}

function sessionListLabel(session) {
  if (session.status === 'waiting') {
    return `! ${sessionLabel(session)} needs ${session.waitingReason ?? 'input'}`;
  }
  return sessionLabel(session);
}

function logSessionEvent(event, details = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details,
  }));
}

function summarizeText(text, max = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

function isApprovalRequest(method) {
  return [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ].includes(method);
}

async function sendLong(chatId, text) {
  for (const chunk of splitTelegramText(text, TELEGRAM_LIMIT)) {
    await send(chatId, chunk);
  }
}

function send(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, ...extra });
}

async function sendWithRetry(chatId, text, extra = {}, { attempts = 1 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await send(chatId, text, extra);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    if (isTelegramNoopEditError(method, json.description)) return null;
    throw new Error(`telegram ${method}: ${json.description}`);
  }
  return json.result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createLoopbackRemoteUrl() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' ? address.port : null;
      server.close((err) => {
        if (err) {
          reject(err);
        } else if (!port) {
          reject(new Error('could not allocate a local port'));
        } else {
          resolve(`ws://127.0.0.1:${port}`);
        }
      });
    });
  });
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function helpText() {
  return [
    'morse',
    '',
    'send any message and i will relay it to the active Codex remote thread for this repo.',
    'for the same session in terminal, run `morse codex` from that repo.',
    'if Codex is busy, messages are queued and run in order.',
    '',
    'commands:',
    '  /help     this message',
    '  /slash    show Codex slash-command buttons',
    '  /sessions list and switch active Codex sessions',
    '  /approvals resend pending approval buttons',
    '  /whoami   show your user id, chat id, active project, and working directory',
    '  /cancel   abort the Codex relay currently in progress',
    '',
    'photos and image documents are sent as image input; voice/audio files are sent as local file paths with the caption as the prompt.',
  ].join('\n');
}

function cliHelpText() {
  return [
    'morse',
    '',
    'commands:',
    '  morse setup    one-time Telegram bot/user setup',
    '  morse start    start the Telegram bridge in the background',
    '  morse stop     stop the background Telegram bridge',
    '  morse enable   set the current directory as the active Codex workspace',
    '  morse codex [codex args]',
    '                 enable this repo and open Codex on the shared remote',
    '  morse status   show setup and active workspace',
    '  morse version  print morse package version',
  ].join('\n');
}
