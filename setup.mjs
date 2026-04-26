#!/usr/bin/env node
// Interactive setup for telegram-codex-bot. Node-only, zero deps.
// Exports `runSetup()` so bot.mjs can call it inline on first run.
//
// Two real touches: paste the bot token, confirm "yes that's me" when we
// detect your Telegram user id from the first message you send to the bot.

import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, '.env');
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

export async function runSetup() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = (q) => rl.question(q);
  const confirm = async (q, def = 'y') => {
    const yn = def === 'y' ? '[Y/n]' : '[y/N]';
    const a = (await ask(`${q} ${yn} `)).trim().toLowerCase();
    if (!a) return def === 'y';
    return a === 'y' || a === 'yes';
  };

  try {
    preamble();

    const { token, bot } = await getBotToken(ask);

    const cwdDefault = process.cwd();
    const cwd = (await ask(`Codex working directory [${cwdDefault}]: `)).trim() || cwdDefault;

    const userId = await detectUserId(token, bot.username, ask, confirm);

    writeEnv(token, userId, cwd);
    console.log('');
    console.log(`open @${bot.username} in Telegram and send /help. controls live in the chat from here on.`);
    console.log('');

    return { token, userId, cwd, botUsername: bot.username };
  } finally {
    rl.close();
  }
}

function preamble() {
  console.log('');
  console.log('== telegram-codex-bot setup (one-time) ==');
  console.log('');
  console.log('This will:');
  console.log('  1. Tell you how to create a bot in @BotFather (you do that in your Telegram app).');
  console.log('  2. Take the bot token you paste here and verify it with Telegram.');
  console.log('  3. Listen for the first message you send to your new bot, read your Telegram user id');
  console.log('     from it, and ask you to confirm before adding it to the allowlist.');
  console.log('  4. Write a .env file in this folder with: bot token, your user id, working directory.');
  console.log('');
  console.log('It will NOT log into your Telegram account, store account credentials, or touch anything');
  console.log('outside this folder. After this, every control lives in the Telegram chat — you should');
  console.log('not need to come back here except to keep the bot process running.');
  console.log('');
}

async function getBotToken(ask) {
  console.log('-- step 1: create a bot in Telegram --');
  console.log('  - Open Telegram, start a chat with @BotFather.');
  console.log('  - Send /newbot. Pick a display name. Pick a username ending in "bot".');
  console.log('  - BotFather replies with an HTTP API token like 1234567890:ABCdef...');
  console.log('');

  while (true) {
    const token = (await ask('paste the token here: ')).trim();
    if (!TOKEN_RE.test(token)) {
      console.log('  ! that does not look like a Telegram bot token. try again.');
      continue;
    }
    process.stdout.write('verifying with Telegram... ');
    try {
      const me = await tg(token, 'getMe');
      console.log(`ok — bot is @${me.username} (id ${me.id})`);
      return { token, bot: me };
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }
}

async function detectUserId(token, botUsername, ask, confirm) {
  console.log('');
  console.log('-- step 2: identify yourself --');
  console.log(`  - In Telegram, open @${botUsername} and send /start (or any message).`);
  console.log('  - I will read the sender id from that message and ask you to confirm.');
  console.log('');

  const initial = await tg(token, 'getUpdates', { offset: -1, limit: 1, timeout: 0 });
  let offset = initial.length ? initial[0].update_id + 1 : 0;
  console.log('listening (Ctrl+C to abort)...');

  while (true) {
    const updates = await tg(token, 'getUpdates', { offset, timeout: 50 });
    for (const u of updates) {
      offset = u.update_id + 1;
      const from = u.message?.from;
      if (!from?.id) continue;
      const label = `${from.first_name ?? ''}${from.username ? ` (@${from.username})` : ''}`.trim() || '(no name)';
      console.log(`  message from ${label}, id ${from.id}`);
      if (await confirm(`add ${from.id} to ALLOWED_USER_IDS?`, 'y')) return from.id;
      console.log('  skipped. waiting for another message...');
    }
  }
}

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || `telegram ${method} failed`);
  return json.result;
}

function writeEnv(token, userId, cwd) {
  if (existsSync(ENV_PATH)) {
    renameSync(ENV_PATH, `${ENV_PATH}.bak`);
    console.log('existing .env moved to .env.bak');
  }
  const lines = [
    `TELEGRAM_BOT_TOKEN=${token}`,
    `ALLOWED_USER_IDS=${userId}`,
    'CODEX_CMD=codex exec',
    `CODEX_CWD=${cwd}`,
    'CODEX_TIMEOUT_SECONDS=600',
    'STREAM_DEBOUNCE_MS=1200',
    '',
  ];
  writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
  console.log(`wrote ${ENV_PATH} (mode 0600)`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runSetup().catch((e) => {
    console.error('error:', e.message || e);
    process.exitCode = 1;
  });
}
