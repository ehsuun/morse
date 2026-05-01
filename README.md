<p align="center">
  <img src="morse.png" alt="morse" width="240">
</p>

# morse

Local Telegram control for Codex.

You bring a Telegram bot token. Morse runs on your machine. There is no morse server.

It is small on purpose. Read it, change it, extend it.

What it does:

- relays allowed Telegram messages into your active Codex terminal session
- streams Codex replies back to Telegram
- shows Codex approval prompts as Telegram buttons
- sends Telegram photos and image documents as image input, and voice/audio messages as local file references
- offers a small inline slash-command palette, including model selection
- switches between active local Codex sessions from Telegram
- keeps all morse state local

## Install

```bash
npm install -g morse-bridge
```

Or install directly from GitHub: `npm install -g git+https://github.com/ehsuun/morse.git`.

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

You can skip `morse start` if you normally launch with `morse codex`; it starts the bridge when needed.

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
codex --remote ws://127.0.0.1:<port>
```

The proxy records the thread id used by the Codex terminal. Telegram messages are sent through the proxy so the terminal and Telegram see the same turn. When `morse codex` exits, the session file is removed and the local app-server is stopped.

If a Codex terminal or app-server dies without a clean exit, morse prunes that stale session the next time sessions are read, such as `/sessions`, `morse status`, or the next Telegram turn. Pending approval buttons are process-local; after a bridge restart, old approval buttons expire and the Codex side must ask again.

To switch repos without opening Codex:

```bash
morse enable
```

Codex args pass through:

```bash
morse codex --resume
morse codex --model gpt-5.2
morse codex resume --last
```

## Telegram

| message | behavior |
|---|---|
| `/help`, `/start` | Show morse help |
| `/slash`, `/commands`, `slash` | Show Codex slash-command buttons |
| Model button in `/slash` | Choose a model from inline buttons |
| `/sessions` | List active Codex sessions and switch with inline buttons |
| `/approvals` | Resend pending Codex approval buttons |
| `/whoami` | Show user id, chat id, active project, and cwd |
| `/cancel` | Interrupt the current Codex turn |
| anything else | Send text to Codex |
| photo / image document | Send the image to Codex, using the caption as the prompt |
| voice / audio file | Download the audio and send Codex the local file path, using the caption as the prompt |

Unknown slash commands are sent to Codex unchanged.

If Codex is busy, messages are queued and sent in order.

If Codex asks for approval, morse sends Telegram buttons.
If a non-active session asks for approval, morse switches the Telegram chat to that session before showing the prompt.
While an approval is pending, regular Telegram messages resend the pending approval instead of being queued behind it.

Downloaded Telegram media is stored under the local morse config directory, in `media/`.

## Commands

```bash
morse setup              # configure Telegram and first workspace
morse start              # start the Telegram bridge in the background
morse stop               # stop the background Telegram bridge
morse restart            # restart the background Telegram bridge after upgrades
morse doctor             # inspect and clean stale local bridge/session state
morse enable             # set current directory as active workspace
morse codex [codex args] # open Codex on the shared local remote
morse status             # print config and active workspace
morse version            # print morse package version
```

After upgrading a global install, run `morse restart` so the background bridge uses the newly installed package code. `morse status` warns when the running bridge version differs from the installed CLI version.

## Versioning

Morse uses SemVer in `package.json`. Use `npm run version:patch`, `npm run version:minor`, or `npm run version:major` to bump the version without creating a git tag.

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
- Treat allowed Telegram users as remote desktop users for the active Codex session.
- Local Codex websocket endpoints bind to loopback. They are not exposed to the LAN or internet.
- Morse is not a same-user sandbox: local processes running as your OS user can generally inspect local state and loopback ports.
- Codex approval and sandbox behavior still apply.
- One `morse start` process should poll a bot token at a time.
- The npm package is `morse-bridge`; the installed CLI is `morse`.

## Development

```bash
npm test
node -e "process.env.MORSE_INTEGRATION='1'; import('./tests/run.mjs')"
node --check bot.mjs
node bot.mjs start --foreground
```

The integration command runs the fake Telegram HTTP server and fake Codex WebSocket app-server tests. They are opt-in because they spawn a foreground bot process and can be blocked by stricter sandboxes.

For multi-session hardening, use this manual smoke loop:

1. Start `morse codex` in two or more repos.
2. Send `/sessions` from Telegram and switch between them.
3. Queue one Telegram message, switch sessions, then queue another.
4. Trigger an approval in one session, switch to another, then answer the approval.
5. Kill one Codex terminal or app-server process.
6. Run `/sessions` and `morse status`; the dead session should disappear or fail clearly, while live sessions continue routing.

Bridge logs include JSON event lines such as `telegram_message`, `run_queued`, `run_started`, `approval_waiting`, `session_selected`, `session_pruned`, and `run_failed` so one Telegram update can be traced through session selection and recovery.
