#!/usr/bin/env node
// Minimal Telegram <-> Codex CLI bridge.
// Zero npm deps. Long-polls Telegram, relays each authorized message into the
// active repo's Codex thread, and streams stdout back.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup } from './setup.mjs';
import { approvalActionLabel, approvalKeyboard, approvalMessage, approvalResponse } from './approvals.mjs';
import {
  TELEGRAM_LIMIT,
  argsAfterOptionalSeparator,
  formatCommandForLog,
  resolveExecutable,
  spawnCommand,
  splitTelegramText,
} from './helpers.mjs';
import { enableWorkspace, globalConfigPath, loadGlobalConfig, loadRuntimeConfig } from './config.mjs';
import { CodexAppServer } from './codex_app_server.mjs';

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

await main();

async function main() {
  const command = process.argv[2] ?? 'start';
  if (command === 'setup') {
    await runSetup();
  } else if (command === 'start') {
    await startBot();
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

  const current = loadRuntimeConfig(process.env, process.cwd());
  const remoteUrl = current?.appServerUrl ?? config.appServerUrl ?? 'ws://127.0.0.1:17373';
  const server = new CodexAppServer({
    command: current?.appServerCommand ?? config.appServerCommand ?? `codex app-server --listen ${remoteUrl}`,
    url: remoteUrl,
    cwd: process.cwd(),
  });
  server.on('stderr', (chunk) => console.error(String(chunk).trimEnd()));
  server.on('fatal', (err) => console.error('codex app-server error', err.message));

  console.log(`morse enabled for ${config.activeWorkspace.label}`);
  console.log(`starting shared remote: ${remoteUrl}`);
  try {
    await server.start();
  } catch (err) {
    console.error(`could not start Codex remote: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const codexArgs = argsAfterOptionalSeparator(process.argv, 3);
  const args = ['--remote', remoteUrl, ...codexArgs];
  const resolved = resolveExecutable('codex') ?? 'codex';

  console.log(`starting: ${formatCommandForLog('codex', args)}`);

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
  server.stop();
}

async function startBot() {
  runtime = await ensureConfigured();
  API = `https://api.telegram.org/bot${runtime.token}`;
  codexServer = new CodexAppServer({ command: runtime.appServerCommand, url: runtime.appServerUrl, cwd: runtime.cwd });
  codexServer.on('stderr', (chunk) => console.error(String(chunk).trimEnd()));
  codexServer.on('fatal', (err) => console.error('codex app-server error', err.message));
  codexServer.on('request', (request) => handleCodexRequest(request).catch((err) => {
    console.error('codex request handler error', err);
    codexServer.respondError(request.id, -32000, err.message || String(err));
  }));

  console.log(`morse ready. allowed=${runtime.allowedUserIds.join(',')} cwd=${runtime.cwd}`);
  console.log(`active workspace: ${runtime.workspaceLabel}`);
  console.log(`codex app-server: ${runtime.appServerCommand}`);
  console.log(`codex remote: codex --remote ${runtime.appServerUrl}`);

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
  console.log(`codex_app_server: ${current.appServerCommand}`);
  console.log(`codex_remote: codex --remote ${current.appServerUrl}`);
  console.log(`active_project: ${current.workspaceLabel}`);
  console.log(`cwd: ${current.cwd}`);
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
  if (!msg?.text) return;

  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!runtime.allowedUserIds.includes(userId)) {
    console.log(`ignored message from unauthorized user ${userId} (${msg.from?.username})`);
    return;
  }
  lastChatId = chatId;

  const text = msg.text.trim();
  if (text === '/start' || text === '/help') {
    await send(chatId, helpText());
    return;
  }
  if (text === '/whoami') {
    const current = loadRuntimeConfig(process.env, process.cwd()) ?? runtime;
    await send(chatId, `user_id: ${userId}\nchat_id: ${chatId}\nactive_project: ${current.workspaceLabel}\ncwd: ${current.cwd}`);
    return;
  }
  if (text === '/cancel') {
    if (activeRun) {
      codexServer.interrupt(activeRun.threadId, activeRun.turnId).catch((err) => console.error('interrupt error', err));
      await send(chatId, `cancelling relay #${activeRun.id}...`);
    } else {
      await send(chatId, 'nothing running.');
    }
    return;
  }

  if (activeRun) {
    await send(chatId, `relay #${activeRun.id} is still working. send /cancel to abort it first.`);
    return;
  }

  const runId = nextRunId++;
  const ack = await send(chatId, `relay #${runId}: ...thinking`);
  try {
    await runCodexStreaming(text, chatId, ack.message_id, runId);
  } catch (err) {
    await send(chatId, `relay #${runId} error: ${formatRunError(err)}`);
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

async function runCodexStreaming(prompt, chatId, ackMessageId, runId) {
  const current = loadRuntimeConfig(process.env, process.cwd()) ?? runtime;
  const streamDebounceMs = current.streamDebounceMs;

  let currentId = ackMessageId;
  let currentText = '';
  let lastEdited = `relay #${runId}: ...thinking`;
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
    const result = await codexServer.relayTurn({
      cwd: current.cwd,
      text: prompt,
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
    await tg('editMessageText', { chat_id: chatId, message_id: currentId, text: `relay #${runId}: (no output)` });
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

async function handleCallbackQuery(query) {
  const userId = query.from?.id;
  if (!runtime.allowedUserIds.includes(userId)) {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Not allowed.', show_alert: true });
    return;
  }

  const match = String(query.data ?? '').match(/^ap:([^:]+):(.+)$/);
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
    '',
    'commands:',
    '  /help     this message',
    '  /whoami   show your user id, chat id, active project, and working directory',
    '  /cancel   abort the Codex relay currently in progress',
  ].join('\n');
}

function cliHelpText() {
  return [
    'morse',
    '',
    'commands:',
    '  morse setup    one-time Telegram bot/user setup',
    '  morse start    run the Telegram polling bridge',
    '  morse enable   set the current directory as the active Codex workspace',
    '  morse codex [codex args]',
    '                 enable this repo and open Codex on the shared remote',
    '  morse status   show setup and active workspace',
  ].join('\n');
}
