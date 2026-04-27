# AGENTS.md

## Project

Morse is a small local Telegram bridge for Codex, not a platform. Keep it inspectable, dependency-light, and local-first. Prefer the smallest reliable Telegram-side control that makes the user's target session obvious. Do not touch Codex UI/output unless there is no cleaner local bridge option.

## Development Loop

1. Check the worktree first with `git status --short`.
2. Read the nearby code before editing; prefer existing helpers and patterns.
3. Keep changes narrow. Do not rewrite unrelated files or revert user changes.
4. Run `npm.cmd test` on Windows, or `npm test` elsewhere.
5. For CLI entry changes, also run `node --check bot.mjs`.
6. Before committing, review `git diff --stat` and `git diff --cached --stat`.

## Versioning

Morse uses SemVer from `package.json`.

- Patch: bug fixes and small behavior improvements.
- Minor: new user-facing commands or compatible features.
- Major: breaking config, CLI, or behavior changes.

Use the safe bump scripts when preparing a release:

```bash
npm run version:patch
npm run version:minor
npm run version:major
```

These update `package.json` without creating a git tag. Review, test, then commit the version bump intentionally.

## Telegram Session Safety

When a Codex session asks for approval or input, route Telegram replies to that session. If needed, switch the chat's active session before prompting so the user never answers the wrong session by accident.
