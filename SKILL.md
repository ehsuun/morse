---
name: telegram-codex-bot-setup
description: Help the user set up telegram-codex-bot on their machine. Trigger when the user asks to "set up the telegram bot", "connect codex to telegram", or runs `npm start` / `node bot.mjs` / `node setup.mjs` from this folder.
---

# Skill: telegram-codex-bot setup

The user is configuring their own Telegram → Codex bridge. The bot's runtime auto-runs setup on first launch, so there's only one command they need: `npm start`. Your job is small — verify preconditions and point them at it. **Do not drive the prompts yourself.** They're how the user gives explicit consent at each step; if you type the token or acknowledgments, you've broken that.

## Preconditions

Run in parallel and report any failures:

1. `node --version` → ≥ 20
2. `which codex` → Codex CLI on PATH
3. Confirm the working directory is `telegram-codex-bot/` (contains `bot.mjs`, `setup.mjs`)

If any fails, tell the user and stop. Do not install anything without explicit permission.

## What to tell the user

> Run `npm start` in this folder. If `.env` doesn't exist yet, it'll fall through into the one-time setup automatically:
>
> 1. It tells you how to create a bot in @BotFather (4 messages in the Telegram app — `/newbot`, display name, username, copy the token).
> 2. You paste that token in the terminal; it's verified with Telegram.
> 3. You pick the Codex working directory (Enter accepts `$PWD`).
> 4. You open your new bot in Telegram and send any message. The script reads your user id from that message and asks you to confirm before adding it to the allowlist.
> 5. Setup finishes, the bot starts polling, and you can send `/help` in Telegram.
>
> Subsequent `npm start`s skip setup and go straight to polling. To re-run setup later, `npm run setup`.

If they want you to walk them through it conversationally, narrate each step but still let **them** type the token and the y/n confirmations. Never type a bot token or user-id confirmation through a tool call you control.

## When something goes wrong

- **"that does not look like a Telegram bot token"** → they pasted the BotFather message, not just the token. Ask for just the `digits:letters` part.
- **`Conflict: terminated by other getUpdates request`** → another process is polling the same token. Stop it (likely an earlier `npm start`) and retry.
- **`Unauthorized` from `getMe`** → wrong token, or the bot was deleted in @BotFather. Re-create or re-paste.
- **Setup listening forever at "step 2"** → user hasn't messaged their bot yet. Remind them to open `@<botusername>` in Telegram and send `/start`.

## After setup

Verify with the user:

1. `.env` exists in this folder with `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, `CODEX_CWD`. Don't print the token; show first 8 + last 4 only if you need to confirm it's populated.
2. Bot logs `telegram-codex-bot ready. allowed=<id> cwd=<path>` after setup.
3. `/help` in Telegram returns the help text.
4. A simple prompt (e.g. "say hello") streams a reply back.

## Things you must NOT do

- Do not commit `.env`, `.env.bak`, or any token. They're in `.gitignore` already — keep it that way.
- Do not echo full tokens in your output to the user.
- Do not modify `setup.mjs` or `bot.mjs` as part of "setting up" — fix the env, not the code.
- Do not push this folder anywhere unless the user explicitly asks.
