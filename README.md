# telegram-codex-bot

A tiny bridge between Telegram and the [Codex CLI](https://github.com/openai/codex). You bring your own bot. You run it on your own machine. Nothing is hosted.

Two files, zero npm dependencies. After a one-time setup you never touch the terminal again — every control lives in the Telegram chat.

## Get going

```bash
git clone <this-repo> telegram-codex-bot
cd telegram-codex-bot
npm install   # no-op (no deps), but won't hurt
npm start
```

The first run has no `.env`, so `npm start` falls into setup. Two real touches:

1. **Paste your bot token.** You'll see how to make a bot in @BotFather (4 messages in the Telegram app); copy the HTTP API token and paste it. The script verifies via `getMe`.
2. **Acknowledge yourself.** Open your new bot in Telegram, send any message. The script reads the sender id from that message and asks: `add <id> to ALLOWED_USER_IDS? [Y/n]`. That's the consent moment.

It also asks for the Codex working directory (`Enter` accepts `$PWD`). Then `.env` is written `0600` and the bot starts polling. Send `/help` in Telegram.

Subsequent runs go straight to polling — no setup, no prompts.

## Prerequisites

- Node.js 20+
- The `codex` CLI on your `PATH`, signed in
- A Telegram account

## What you can send

| in Telegram | what happens |
|---|---|
| `/help`, `/start` | show usage |
| `/whoami` | print your user id, chat id, working directory |
| `/cancel` | abort the codex run currently in progress |
| anything else | piped to `codex exec` as a prompt; output streams back into the same chat message, debounced ~1.2s |

When Codex's output gets longer than Telegram's 4000-char message limit, the bot seals the current message on a paragraph or line boundary and starts a new one. ANSI color codes are stripped.

## Keep it running

```bash
nohup npm start >bot.log 2>&1 &
# or use tmux, pm2, a systemd unit, etc.
```

## What it doesn't do

- No multi-tenant hosting. One token, one machine, one allowlist.
- No webhook, no public URL.
- No persisted history, no auth UI, no database.
- No token-by-token streaming — debounced edits keep us under Telegram's rate limit.

## Security notes

This bot lets your Telegram chat run an autonomous coding agent on your machine. That is the point, and it is dangerous if misused.

- **Keep the bot token secret.** Anyone with it can send messages to your bot; they still need to be on `ALLOWED_USER_IDS` to be processed, but treat the token like a password.
- **Lock the allowlist.** Setup writes exactly one user id. To add more, edit `ALLOWED_USER_IDS` (comma-separated). Never leave it empty — the bot refuses to start.
- **Pick the working directory deliberately.** Codex reads, writes, and runs commands inside `CODEX_CWD`. Don't point it at `$HOME`.
- **Codex's approval mode applies as-is.** If you set `CODEX_CMD=codex exec --full-auto`, the bot is `--full-auto` too.

## Re-run setup / change settings

```bash
npm run setup   # forces the interactive flow (backs up existing .env)
```

Or edit `.env` directly. Keys: `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, `CODEX_CMD`, `CODEX_CWD`, `CODEX_TIMEOUT_SECONDS`, `STREAM_DEBOUNCE_MS`.

## Layout

```
telegram-codex-bot/
├── bot.mjs        # runtime — Telegram <-> codex exec bridge; auto-runs setup on first launch
├── setup.mjs      # interactive setup — exported, also runnable directly
├── SKILL.md       # runbook a Codex agent follows when asked to set this up
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Extracting to its own repo

Fully self-contained — no imports from the parent project. To split it out:

```bash
# preserve history:
git filter-repo --subdirectory-filter telegram-codex-bot

# or just copy:
cp -r telegram-codex-bot/ ../telegram-codex-bot-standalone
cd ../telegram-codex-bot-standalone && git init && git add . && git commit -m "initial import"
```
