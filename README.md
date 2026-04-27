<p align="center">
  <img src="morse.png" alt="morse" width="240">
</p>

# morse

Morse is a local Telegram remote control for Codex.

You create your own Telegram bot, run morse on your own machine, and use Telegram as a control surface for the active Codex workspace. There is no morse server, account, webhook, database, or hosted relay.

The intended flow is:

```bash
morse start      # keep the Telegram bridge online
morse codex      # open Codex in this repo on the shared local remote
```

Then you can work in the Codex terminal UI, step away, and continue from Telegram.

## Requirements

- Node.js 20+
- Codex installed and signed in
- A Telegram account

## Install

From this checkout:

```bash
npm install -g .
```

Verify the command is available:

```bash
morse status
```

This repo is still private and not published to npm. For local development, `npm link` is also fine.

## One-Time Setup

```bash
morse setup
```

Setup does three things:

1. Helps you create a Telegram bot with `@BotFather`.
2. Verifies the bot token with Telegram.
3. Saves your allowed Telegram user id and first Codex workspace.

The config is written once at:

- Windows: `%APPDATA%\morse\config.json`
- macOS/Linux: `~/.config/morse/config.json`

Your bot token stays on your machine. Telegram messages go through `api.telegram.org`; Codex traffic stays between this machine and the local Codex app-server.

## Daily Use

Keep the bridge running in one terminal:

```bash
morse start
```

That process polls Telegram and relays allowed messages into Codex. It must stay running for the bot to reply.

In the repo you want Codex to work in, start Codex through morse:

```bash
cd path/to/repo
morse codex
```

`morse codex` does two things:

1. Marks the current repo as the active morse workspace.
2. Opens `codex --remote ws://127.0.0.1:17373`.

Telegram and the terminal UI then share the same local Codex app-server thread. This is the phone handoff path.

Codex args pass through:

```bash
morse codex --resume
morse codex --model gpt-5.2
```

If you only want to switch the active repo without opening Codex:

```bash
morse enable
```

## Telegram Commands

| message | behavior |
|---|---|
| `/help`, `/start` | Show bot help |
| `/slash`, `/commands`, `slash` | Show Codex slash-command buttons |
| `/whoami` | Show your user id, chat id, active project, and cwd |
| `/cancel` | Interrupt the current Codex relay |
| anything else | Send a turn to Codex for the active workspace |

Only one Codex turn runs at a time.

Long Codex replies are streamed back by editing the current Telegram message, then split into follow-up messages only when Telegram's message limit requires it.

If you send another message while Codex is still working, morse queues it and sends it after the current turn finishes.

Unknown slash commands are relayed to Codex unchanged. For common Codex slash commands, send `slash` and tap a button such as `/review` or `/compact`.

When Codex needs approval, morse sends a Telegram message with inline buttons. You can approve once, approve for the session, deny, or abort directly from Telegram. This is used for command execution, file changes, and extra permission requests.

## How It Works

Morse uses Codex's local app-server:

```bash
codex app-server --listen ws://127.0.0.1:17373
```

`morse start` connects to that app-server and to Telegram. `morse codex` opens the Codex terminal UI against the same app-server with:

```bash
codex --remote ws://127.0.0.1:17373
```

When the active thread is already loaded by the terminal UI, morse resumes it on the bridge connection so it can receive response events and stream them back to Telegram.

## Commands

```bash
morse setup              # one-time Telegram bot/user setup
morse start              # run the Telegram polling bridge
morse enable             # set current directory as active workspace
morse codex [codex args] # enable current repo and open Codex on the shared remote
morse status             # show setup and active workspace
```

## Security Notes

This bot lets Telegram talk to a coding agent on your machine.

- Keep the Telegram bot token secret.
- Keep the allowlist narrow.
- Enable workspaces deliberately.
- Codex approval and sandbox behavior still apply.
- Morse ignores Telegram users outside `allowedUserIds`.

## Troubleshooting

**No Telegram response after setup**

Run `morse start` and keep it open. Setup only writes config.

**Telegram shows `working...` forever**

Restart both sides so they load the latest morse code:

```bash
npm install -g .
morse start
morse codex
```

If it still hangs, check the `morse start` terminal logs.

**Codex receives Telegram messages but Telegram does not receive replies**

Make sure Codex was opened with `morse codex`, not a standalone Codex session. Morse can only share the local remote session it is connected to.

**Codex is waiting for approval**

Use the approval buttons in Telegram. If no buttons appear, restart `morse start`; older bridge processes did not handle app-server approval requests.

**`could not find the Codex CLI`**

Open or install Codex once so the `codex` command is available. On Windows, morse also checks the Codex app install location automatically.

**Telegram `Conflict: terminated by other getUpdates request`**

Another morse process is polling the same bot token. Stop the old bridge and start one process.

## Config

Global config example:

```json
{
  "telegramBotToken": "...",
  "allowedUserIds": [123456789],
  "appServerUrl": "ws://127.0.0.1:17373",
  "appServerCommand": "codex app-server --listen ws://127.0.0.1:17373",
  "timeoutSeconds": 600,
  "streamDebounceMs": 1200,
  "activeWorkspace": {
    "cwd": "J:\\Projects\\some-repo",
    "label": "some-repo",
    "enabledAt": "2026-04-26T00:00:00.000Z"
  }
}
```

Legacy repo-local `.env` config is still recognized as a fallback for older clones. New setup writes the global config.

## Development

```bash
npm test
npm run setup
npm start
```

The npm scripts are for working inside this repo. End users should use the global `morse` command.
