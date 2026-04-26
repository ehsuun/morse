#!/usr/bin/env node
// Minimal Telegram <-> Codex CLI bridge.
// One file. Zero npm deps. Long-polls Telegram, pipes each authorized message
// through `codex exec`, streams stdout back. First run with no .env triggers
// setup.mjs inline. Every other control lives in the Telegram chat.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup } from './setup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, '.env');
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const TELEGRAM_LIMIT = 4000;

await ensureConfigured();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = (process.env.ALLOWED_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
const CODEX_CMD = (process.env.CODEX_CMD ?? 'codex exec').trim();
const CODEX_CWD = process.env.CODEX_CWD?.trim() || process.cwd();
const TIMEOUT_MS = (Number(process.env.CODEX_TIMEOUT_SECONDS ?? 600) || 0) * 1000;
const STREAM_DEBOUNCE_MS = Number(process.env.STREAM_DEBOUNCE_MS ?? 1200) || 1200;
const API = `https://api.telegram.org/bot${TOKEN}`;

// One in-flight codex run per chat. /cancel kills it.
const runs = new Map();

console.log(`morse ready. allowed=${ALLOWED.join(',')} cwd=${CODEX_CWD}`);
console.log(`codex command: ${CODEX_CMD}`);

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

async function ensureConfigured() {
  loadDotEnv(ENV_PATH);
  const haveToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const haveAllowlist = !!(process.env.ALLOWED_USER_IDS ?? '').trim();
  if (haveToken && haveAllowlist) return;
  console.log('no .env found — running first-time setup.');
  await runSetup();
  loadDotEnv(ENV_PATH);
  if (!process.env.TELEGRAM_BOT_TOKEN || !(process.env.ALLOWED_USER_IDS ?? '').trim()) {
    console.error('setup did not complete. exiting.');
    process.exit(1);
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;

  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!ALLOWED.includes(userId)) {
    console.log(`ignored message from unauthorized user ${userId} (${msg.from?.username})`);
    return;
  }

  const text = msg.text.trim();
  if (text === '/start' || text === '/help') {
    await send(chatId, helpText());
    return;
  }
  if (text === '/whoami') {
    await send(chatId, `user_id: ${userId}\nchat_id: ${chatId}\ncwd: ${CODEX_CWD}`);
    return;
  }
  if (text === '/cancel') {
    const child = runs.get(chatId);
    if (child) {
      child.kill('SIGTERM');
      await send(chatId, 'cancelling...');
    } else {
      await send(chatId, 'nothing running.');
    }
    return;
  }

  if (runs.has(chatId)) {
    await send(chatId, 'still working on the previous message. send /cancel to abort it first.');
    return;
  }

  const ack = await send(chatId, '...thinking');
  try {
    await runCodexStreaming(text, chatId, ack.message_id);
  } catch (err) {
    await send(chatId, `error: ${err.message}`);
  }
}

async function runCodexStreaming(prompt, chatId, ackMessageId) {
  const [bin, ...baseArgs] = CODEX_CMD.split(/\s+/);
  const child = spawn(bin, [...baseArgs, prompt], { cwd: CODEX_CWD });
  runs.set(chatId, child);

  let currentId = ackMessageId;
  let currentText = '';
  let lastEdited = '...thinking';
  let pending = null;
  let stderrBuf = '';

  const flush = async () => {
    pending = null;
    if (!currentText.trim()) return;

    while (currentText.length > TELEGRAM_LIMIT) {
      const cut = niceCut(currentText, TELEGRAM_LIMIT);
      const head = currentText.slice(0, cut);
      const tail = currentText.slice(cut);
      if (head !== lastEdited) {
        await tg('editMessageText', { chat_id: chatId, message_id: currentId, text: head });
      }
      const next = await send(chatId, tail || '...');
      currentId = next.message_id;
      currentText = tail;
      lastEdited = tail || '...';
    }

    if (currentText !== lastEdited) {
      await tg('editMessageText', { chat_id: chatId, message_id: currentId, text: currentText });
      lastEdited = currentText;
    }
  };

  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => flush().catch((e) => console.error('flush error', e)), STREAM_DEBOUNCE_MS);
  };

  let timer;
  if (TIMEOUT_MS > 0) {
    timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
  }

  child.stdout.on('data', (d) => {
    currentText += d.toString().replace(ANSI_RE, '');
    schedule();
  });
  child.stderr.on('data', (d) => (stderrBuf += d.toString()));

  let exitCode;
  let exitSignal;
  try {
    [exitCode, exitSignal] = await new Promise((res, rej) => {
      child.on('error', rej);
      child.on('close', (c, s) => res([c, s]));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (pending) clearTimeout(pending);
    runs.delete(chatId);
  }
  await flush();

  if (exitSignal === 'SIGTERM' || exitSignal === 'SIGKILL') {
    await send(chatId, 'cancelled.');
  } else if (exitCode !== 0) {
    const detail = stderrBuf.replace(ANSI_RE, '').trim() || '(no stderr)';
    await send(chatId, `codex exited ${exitCode}\n${detail.slice(0, TELEGRAM_LIMIT)}`);
  } else if (!currentText.trim()) {
    await tg('editMessageText', { chat_id: chatId, message_id: currentId, text: '(no output)' });
  }
}

function niceCut(text, limit) {
  const slice = text.slice(0, limit);
  const para = slice.lastIndexOf('\n\n');
  if (para > limit * 0.5) return para + 2;
  const nl = slice.lastIndexOf('\n');
  if (nl > limit * 0.5) return nl + 1;
  return limit;
}

function send(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text });
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
    'send any message and i will run it through `codex exec` on the host machine.',
    '',
    'commands:',
    '  /help     this message',
    '  /whoami   show your user id, chat id, and the working directory',
    '  /cancel   abort the codex run currently in progress',
  ].join('\n');
}
