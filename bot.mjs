#!/usr/bin/env node
// Minimal Telegram <-> Codex CLI bridge.
// Zero npm deps. Long-polls Telegram, relays each authorized message into the
// active repo's Codex thread, and streams stdout back.

import { closeSync, mkdirSync, openSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup } from './setup.mjs';
import { approvalActionLabel, approvalKeyboard, approvalMessage, approvalResponse } from './approvals.mjs';
import {
  TELEGRAM_LIMIT,
  argsAfterOptionalSeparator,
  codexArgsForRemote,
  formatCommandForLog,
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
import {
  isSlashPaletteRequest,
  modelChoiceById,
  modelChoiceKeyboard,
  modelChoiceMessage,
  slashCommandById,
  slashCommandKeyboard,
  slashCommandMessage,
} from './slash_commands.mjs';
import { authorizeTelegramPeer } from './telegram_auth.mjs';
import { CodexWebSocketProxy } from './websocket_proxy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, '.env');
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

let runtime;
let API;
let codexServer;

// This bot is built for one private control thread. Keep one Codex relay active.
let activeRun = null;
let nextRunId = 1;
let nextApprovalId = 1;
let lastChatId = null;
const pendingApprovals = new Map();
const queuedRuns = [];
let queueDraining = false;

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

  const state = {
    appServerUrl: remoteUrl,
    appServerCommand,
    proxyUrl,
    pid: server.child?.pid,
    cwd: process.cwd(),
    workspaceLabel: config.activeWorkspace.label,
    startedAt: new Date().toISOString(),
  };
  proxy.on('active-thread', (threadId) => {
    if (state.activeThreadId === threadId) return;
    state.activeThreadId = threadId;
    state.activeThreadUpdatedAt = new Date().toISOString();
    saveRuntimeState(state);
  });
  const statePath = saveRuntimeState(state);
  console.log(`session: ${statePath}`);

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
  API = `https://api.telegram.org/bot${runtime.token}`;
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
  const state = loadRuntimeState();
  if (state?.appServerUrl) {
    console.log('session_status: active');
    console.log(`codex_remote: codex --remote ${state.appServerUrl}`);
    if (state.proxyUrl) console.log(`codex_proxy: codex --remote ${state.proxyUrl}`);
    console.log(`terminal_thread: ${state.activeThreadId ?? 'not connected yet'}`);
  } else {
    console.log('session_status: none');
  }
  if (config?.activeWorkspace?.enabledAt) console.log(`enabled_at: ${config.activeWorkspace.enabledAt}`);
}

function maskToken(token) {
  if (!token) return '(missing)';
  if (token.length <= 12) return '(set)';
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
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

  const inputItems = attachments.length ? turnInputFromTextAndAttachments(text, attachments) : null;
  await enqueueRun(text, chatId, inputItems);
}

async function enqueueRun(text, chatId, inputItems = null) {
  const runId = nextRunId++;
  const queued = activeRun || queueDraining || queuedRuns.length > 0;
  const ack = await send(chatId, queued ? `queued (${queuedRuns.length + 1} ahead)` : 'working...');
  queuedRuns.push({ id: runId, text, inputItems, chatId, ackMessageId: ack.message_id });
  drainQueue().catch((err) => console.error('queue drain error', err));
}

async function drainQueue() {
  if (queueDraining) return;
  queueDraining = true;
  try {
    while (queuedRuns.length > 0) {
      const run = queuedRuns.shift();
      try {
        await runCodexStreaming(run.text, run.chatId, run.ackMessageId, run.id, run.inputItems);
      } catch (err) {
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

  const attachments = [];
  for (const descriptor of descriptors) {
    attachments.push({
      type: 'localImage',
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

async function runCodexStreaming(prompt, chatId, ackMessageId, runId, inputItems = null) {
  const current = loadRuntimeConfig(process.env, process.cwd()) ?? runtime;
  const streamDebounceMs = current.streamDebounceMs;
  const state = await waitForActiveCodexThread();
  const server = await ensureCodexServer(state);
  console.log(`run ${runId}: relaying to thread ${state.activeThreadId} via ${state.proxyUrl ?? state.appServerUrl}`);

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
      cwd: current.cwd,
      text: prompt,
      inputItems,
      threadId: state.activeThreadId,
      timeoutMs: current.timeoutSeconds > 0 ? current.timeoutSeconds * 1000 : 0,
      onStarted: ({ threadId, turnId }) => {
        activeRun = { id: runId, threadId, turnId, chatId };
      },
      onDelta: (delta) => {
        currentText += delta.replace(ANSI_RE, '');
        schedule();
      },
    });
  } finally {
    if (pending) clearTimeout(pending);
    if (activeRun?.id === runId) activeRun = null;
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

  if (!isApprovalRequest(request.method)) {
    await send(chatId, `Codex requested unsupported client action:\n${request.method}`);
    codexServer.respondError(request.id, -32601, `unsupported request: ${request.method}`);
    return;
  }

  const approvalId = String(nextApprovalId++);
  const keyboard = approvalKeyboard(request.method).map((row) => row.map((button) => ({
    text: button.text,
    callback_data: `ap:${approvalId}:${button.callback_data}`,
  })));
  const message = await send(chatId, approvalMessage(request.method, request.params), {
    reply_markup: { inline_keyboard: keyboard },
  });

  pendingApprovals.set(approvalId, {
    request,
    chatId,
    messageId: message.message_id,
    createdAt: Date.now(),
  });
}

async function waitForActiveCodexThread(timeoutMs = 20000) {
  const started = Date.now();
  while (true) {
    const state = loadRuntimeState();
    if (!state?.appServerUrl || !state?.appServerCommand) {
      throw new Error('no active Codex remote. Run `morse codex` from the repo first and keep it open.');
    }
    if (state.pid && !isProcessAlive(state.pid)) {
      clearRuntimeState(state);
      throw new Error('the active Codex remote is no longer running. Run `morse codex` again.');
    }
    if (state.activeThreadId) return state;
    if (Date.now() - started >= timeoutMs) {
      throw new Error('Codex terminal is not connected yet. Wait for `morse codex` to finish opening, then send the message again.');
    }
    await sleep(500);
  }
}

async function ensureCodexServer(state = loadRuntimeState()) {
  if (!state?.appServerUrl || !state?.appServerCommand) {
    throw new Error('no active Codex remote. Run `morse codex` from the repo first and keep it open.');
  }
  if (state.pid && !isProcessAlive(state.pid)) {
    clearRuntimeState(state);
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

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
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
    '  /whoami   show your user id, chat id, active project, and working directory',
    '  /cancel   abort the Codex relay currently in progress',
    '',
    'photos and image documents are sent to Codex with the caption as the prompt.',
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
  ].join('\n');
}
