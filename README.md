# opencode-discord

Lite Discord proxy for [OpenCode](https://opencode.ai).

Each Discord channel maps to a project directory. A message in that channel starts a thread. Each thread maps to one OpenCode session. The bot posts OpenCode events back to the thread using the original Kimaki-style prefixes.

This is a proxy only. No critics, analytics, voice, worktrees, slash commands, or queue UI.

## What it does

```
Discord message in a project channel
  → create thread
  → OpenCode session.create + promptAsync
  → SSE events
  → Discord messages
```

Follow-up messages in the same thread continue the same session.

## UI

| Kind | Prefix |
|---|---|
| Text | none (classic Discord content) |
| Thinking | `┣ thinking` |
| Tool | `┣ bash _echo hello_` |
| Edit / write | `◼︎ edit *file.ts* (+3-1)` |
| Tool error | `⨯ bash ...` |
| Context / notices | `⬦ ...` |
| File | `📄 notes.md` |
| Todo | `⒊ **do the thing**` |

Default verbosity is `text_and_essential_tools`: hide `read` / `glob` / `grep` / thinking / non-side-effect bash. Use `--verbosity tools_and_text` to show everything.

Text parts are posted as classic Discord content. A tool after text gets a Components V2 separator first. Consecutive same-kind parts stay classic content.

Typing uses Discord `sendTyping()` every 7 seconds while the session is busy.

When a turn finishes, the model pings the user on the last line (`<@userId> short summary`).

## Setup

1. Create a Discord bot, enable **Message Content Intent**, invite it with the `bot` scope and **View Channel** + **Manage Channels** (needed by `add-project`) plus Send Messages, Create Public Threads, Send Messages in Threads, Manage Threads, Embed Links, Attach Files, and Read Message History. The bot must be in the same server as `DISCORD_CATEGORY_ID`.
2. Install [OpenCode](https://opencode.ai) so `opencode` is on `PATH`.
3. Install this package:

```bash
cd ~/projects/opencode-discord
pnpm install
```

 4. Put the bot token and project category in `.env` or the environment:

```
DISCORD_BOT_TOKEN=...
DISCORD_CATEGORY_ID=...
```

5. Add a project, then start:

```bash
pnpm add-project
pnpm start
```

`add-project` scans `~` for git repos, asks you to pick a directory, and creates a Discord channel in that category.

Send a message in that channel. The bot creates a thread and runs OpenCode there.

## Commands

```
opencode-discord start [--token TOKEN] [--data-dir DIR] [--verbosity LEVEL]
opencode-discord add [--dir PROJECT_DIR]
opencode-discord remove --channel CHANNEL_ID
opencode-discord list
```

Data lives in `~/.local/share/opencode-discord/` (`sessions.db`, `opencode-discord.log`).

## Requirements

- Node 22+
- `opencode` CLI on PATH
- Discord bot with Message Content Intent
