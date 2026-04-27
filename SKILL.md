---
name: morse-setup
description: Help the user set up morse on their machine. Trigger when the user asks to "set up the telegram bot", "connect codex to telegram", "enable morse", or runs `morse setup` / `morse enable` / `morse start` / `morse codex`.
---

# Skill: morse setup

The user is configuring their own Telegram -> Codex bridge. Morse should be installed globally and set up once.

Morse relays Telegram prompts through Codex's experimental local app-server websocket for the active `morse codex` session. `morse start` starts the Telegram bridge in the background; `morse codex` starts the bridge if needed, starts the per-run app-server on a random loopback port, creates one shared Codex thread, and opens the terminal UI on that thread.

Do not drive the interactive prompts yourself. The token paste and user-id confirmation are consent moments; if you type the token or acknowledgments, you have broken that.

## Preconditions

Run in parallel and report any failures:

1. `node --version` -> >= 20
2. `where codex` on Windows or `which codex` elsewhere -> Codex CLI on PATH
3. `where morse` / `which morse` if globally installed, or confirm this checkout contains `bot.mjs`, `setup.mjs`, `config.mjs`

If any fails, tell the user and stop. Do not install anything without explicit permission.

## Install

From the morse checkout:

```bash
npm install -g .
```

For local development, `npm link` is also acceptable. End users should use the global `morse` command, not `npm start`.

## One-Time Setup

```bash
morse setup
```

Setup flow:

1. User creates a bot in @BotFather (`/newbot`, display name, username, copy token).
2. User pastes the token in the terminal; setup verifies it with Telegram.
3. User picks the initial Codex workspace.
4. User opens the new bot in Telegram and sends any message.
5. Setup reads the sender id and asks the user to confirm before allowlisting.
6. Setup writes the global config and tells the user to start the bridge.

Global config locations:

- Windows: `%APPDATA%\morse\config.json`
- macOS/Linux: `~/.config/morse/config.json`

## Daily Use

Start the local bridge:

```bash
morse start
```

Stop it:

```bash
morse stop
```

From any repo:

```bash
morse codex
```

Then Telegram messages relay into that Codex session.

To change the active workspace without opening Codex:

```bash
morse enable
```

Codex CLI args pass through unchanged:

```bash
morse codex --resume
```

## When Something Goes Wrong

- **No Telegram response after setup** -> setup only saved config; run `morse start` or `morse codex`.
- **No Codex response / no active remote** -> run `morse codex` from the repo and keep it open.
- **App-server fails** -> restart `morse codex` and check the terminal logs.
- **`could not find the Codex CLI` / `spawn codex ENOENT`** -> open/install Codex once so the command is available, or set `appServerCommand` to the full codex app-server command. On Windows, morse checks the Codex app install location automatically.
- **"that does not look like a Telegram bot token"** -> they pasted the BotFather message, not just the token. Ask for just the `digits:letters` part.
- **`Conflict: terminated by other getUpdates request`** -> another bridge process is polling the same token. Stop it and retry.
- **`Unauthorized` from `getMe`** -> wrong token, or the bot was deleted in @BotFather. Re-create or re-paste.
- **Setup listening forever** -> user has not messaged their bot yet. Remind them to open `@<botusername>` in Telegram and send `/start`.
- **`morse enable` says setup is missing** -> run `morse setup` first, then enable the repo.

## After Setup

Verify with the user:

1. `morse status` shows `status: configured` and the intended active workspace.
2. Start the bridge with `morse start`; it should print `morse is up and running`.
3. Run `morse codex` from the repo and keep that Codex session open.
4. `morse status` shows `session_status: active`.
5. `/help` in Telegram returns the help text.
6. `/whoami` shows the active project and cwd.
7. A simple prompt, such as "say hello", streams a reply back.

## Things You Must Not Do

- Do not commit global config, `.env`, `.env.bak*`, or any token.
- Do not echo full tokens in your output to the user.
- Do not type bot tokens or user-id confirmations through a tool call you control.
- Do not push this folder anywhere unless the user explicitly asks.
