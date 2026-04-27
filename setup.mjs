#!/usr/bin/env node
// Interactive setup for morse. Node-only, zero deps.
// Exports `runSetup()` so bot.mjs can call it inline on first run.
//
// Two real touches: paste the bot token, confirm "yes that's me" when we
// detect your Telegram user id from the first message you send to the bot.

import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { nextBackupPath } from './helpers.mjs';
import { globalConfigPath, saveGlobalConfig, workspaceFromCwd } from './config.mjs';

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

    console.log('');
    console.log('[2/3] Codex workspace');
    console.log('Pick the first repo Codex should work in. You can switch later with `morse enable`.');
    console.log('');
    const cwdDefault = process.cwd();
    const cwd = (await ask(`workspace [${cwdDefault}]: `)).trim() || cwdDefault;

    const { userId, chatId } = await detectUserId(token, bot.username, ask, confirm);

    const configPath = writeGlobalConfig(token, userId, chatId, cwd);
    console.log('');
    console.log('setup complete');
    console.log(`config: ${configPath}`);
    console.log('');
    console.log('Next:');
    console.log('  1. Start the local bridge and keep it running: `morse start`.');
    console.log('  2. Open Codex through morse: `morse codex` (Codex args pass through, e.g. `--resume`).');
    console.log(`  3. Open @${bot.username} in Telegram and send /help.`);
    console.log('');
    console.log('To switch repos later, run `morse enable` from that repo.');
    console.log('');

    return { token, userId, chatId, cwd, botUsername: bot.username };
  } finally {
    rl.close();
  }
}

function preamble() {
  console.log('morse');
  console.log('local Telegram control for Codex');
  console.log('No morse server. No account. Your bot token stays on this machine.');
  console.log('Telegram and Codex can share one local remote-control session.');
  console.log('');
  console.log('Setup has three steps:');
  console.log('  [1/3] connect your Telegram bot');
  console.log('  [2/3] choose the first Codex workspace');
  console.log('  [3/3] allowlist your Telegram user id');
  console.log('');
  console.log('Nothing is saved until you confirm your user id. Ctrl+C exits.');
  console.log('');
}

async function getBotToken(ask) {
  console.log('[1/3] Telegram bot');
  console.log('Open @BotFather, send /newbot, then paste the HTTP API token.');
  console.log('');

  while (true) {
    const token = (await ask('token: ')).trim();
    if (!TOKEN_RE.test(token)) {
      console.log('That does not look like a Telegram bot token. Paste only the digits:letters token.');
      continue;
    }
    process.stdout.write('verifying with Telegram... ');
    try {
      const me = await tg(token, 'getMe');
      console.log(`ok - bot is @${me.username} (id ${me.id})`);
      return { token, bot: me };
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }
}

async function detectUserId(token, botUsername, ask, confirm) {
  console.log('');
  console.log('[3/3] Allowlist yourself');
  console.log(`Open @${botUsername} in Telegram and send /start.`);
  console.log('Morse will detect the sender id and ask you to confirm.');
  console.log('');

  const initial = await tg(token, 'getUpdates', { offset: -1, limit: 1, timeout: 0 });
  let offset = initial.length ? initial[0].update_id + 1 : 0;
  console.log('listening (Ctrl+C to abort)...');

  while (true) {
    const updates = await tg(token, 'getUpdates', { offset, timeout: 50 });
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      const from = msg?.from;
      if (!from?.id) continue;
      const label = `${from.first_name ?? ''}${from.username ? ` (@${from.username})` : ''}`.trim() || '(no name)';
      console.log(`  message from ${label}, id ${from.id}`);
      if (msg.chat?.type !== 'private') {
        console.log('  ignored because setup must be completed in a private chat with your bot.');
        continue;
      }
      if (await confirm(`add ${from.id} to ALLOWED_USER_IDS?`, 'y')) return { userId: from.id, chatId: msg.chat.id };
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

function writeGlobalConfig(token, userId, chatId, cwd) {
  const path = globalConfigPath();
  if (existsSync(path)) {
    const backupPath = nextBackupPath(path, existsSync);
    renameSync(path, backupPath);
    console.log(`existing morse config moved to ${backupPath}`);
  }
  saveGlobalConfig({
    telegramBotToken: token,
    allowedUserIds: [userId],
    allowedChatIds: [chatId],
    timeoutSeconds: 600,
    streamDebounceMs: 1200,
    activeWorkspace: workspaceFromCwd(cwd),
  }, path);
  return path;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runSetup().catch((e) => {
    console.error('error:', e.message || e);
    process.exitCode = 1;
  });
}
