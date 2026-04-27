<p align="center">
  <img src="morse.png" alt="morse" width="240">
</p>

# morse

Local Telegram control for Codex.

You bring a Telegram bot token. Morse runs on your machine. There is no morse server.

It is small on purpose. Read it, change it, extend it.

## Install

```bash
git clone https://github.com/ehsuun/morse.git
cd morse
npm install -g .
```

Requirements:

- Node.js 20+
- Codex installed and signed in
- Telegram

## Use

Set up morse:

```bash
morse setup
```

Run morse:

```bash
morse start
```

This starts the Telegram bridge in the background. `morse codex` also starts it if needed.

Do this from the repo you want Codex to work in:

```bash
morse codex
```

Then use Telegram. If you switch repos, run `morse codex` or `morse enable` from the new repo.

## Setup

Run once:

```bash
morse setup
```

Setup creates a user config:

- Windows: `%APPDATA%\morse\config.json`
- macOS/Linux: `~/.config/morse/config.json`

It stores:

- your Telegram bot token
- allowed Telegram user ids
- allowed Telegram private chat ids
- the active Codex workspace

Your token stays on your machine. Telegram traffic goes through `api.telegram.org`. Codex uses its normal Codex services.

## Run

Start the Telegram bridge:

```bash
morse start
```

Stop the background bridge:

```bash
morse stop
```

In a repo:

```bash
morse codex
```

This marks the repo active, starts a per-run local Codex app-server on a random loopback port, and opens Codex through a local proxy:

```bash
codex --remote ws://127.0.0.1:<port> resume --last
```

The proxy records the thread id used by the Codex terminal. Telegram messages are sent to that same thread. When `morse codex` exits, the session file is removed and the local app-server is stopped.

To switch repos without opening Codex:

```bash
morse enable
```

Codex args pass through:

```bash
morse codex --resume
morse codex --model gpt-5.2
```

## Telegram

| message | behavior |
|---|---|
| `/help`, `/start` | Show morse help |
| `/slash`, `/commands`, `slash` | Show Codex slash-command buttons |
| `/whoami` | Show user id, chat id, active project, and cwd |
| `/cancel` | Interrupt the current Codex turn |
| anything else | Send text to Codex |

Unknown slash commands are sent to Codex unchanged.

If Codex is busy, messages are queued and sent in order.

If Codex asks for approval, morse sends Telegram buttons.

## Commands

```bash
morse setup              # configure Telegram and first workspace
morse start              # start the Telegram bridge in the background
morse stop               # stop the background Telegram bridge
morse enable             # set current directory as active workspace
morse codex [codex args] # open Codex on the shared local remote
morse status             # print config and active workspace
```

## Config

Example:

```json
{
  "telegramBotToken": "...",
  "allowedUserIds": [123456789],
  "allowedChatIds": [123456789],
  "timeoutSeconds": 600,
  "streamDebounceMs": 1200,
  "activeWorkspace": {
    "cwd": "J:\\Projects\\some-repo",
    "label": "some-repo",
    "enabledAt": "2026-04-26T00:00:00.000Z"
  }
}
```

Legacy `.env` config is still read as a fallback.

## Notes

- Keep the bot token secret.
- Keep the allowlist small.
- Morse only responds to allowed users in allowed private chats.
- Codex approval and sandbox behavior still apply.
- One `morse start` process should poll a bot token at a time.
- This is not an npm package yet. Install from the checkout.

## Development

```bash
npm test
node bot.mjs start --foreground
```
