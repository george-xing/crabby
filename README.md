# Crabby

Personal AI assistant that runs on Telegram, powered by Claude Code CLI.

Crabby spawns Claude Code as a subprocess for each conversation, giving it access to MCP servers for persistent memory, Google Workspace, and scheduling. Sessions persist across messages with automatic context recovery when sessions reset.

## Features

- **Conversational AI** — Claude Code CLI with streaming responses to Telegram
- **Persistent memory** — Remembers facts, preferences, and contacts across sessions
- **Google Workspace** — Gmail, Calendar, Drive, Sheets, Docs via MCP server
- **Reminders & scheduling** — One-shot, recurring, and daily morning briefings
- **Session continuity** — Resumes conversations with `--resume`; gracefully recovers with recent context on session reset
- **User auth** — Telegram user ID whitelist

## Architecture

```
Telegram <-> grammY bot <-> Orchestrator <-> Claude Code CLI (subprocess)
                                                  |
                                          MCP Servers:
                                          - crabby-memory (SQLite)
                                          - gws (Google Workspace)
                                          - crabby-scheduler (cron + SQLite)
```

## Project Structure

```
src/
├── claude/           # Claude Code subprocess, session management, streaming
├── mcp/
│   ├── memory-server/    # remember, recall, forget tools
│   ├── gws-server/       # Google Workspace integration
│   └── scheduler-server/ # reminders and briefings
├── memory/           # SQLite-backed memory storage
├── scheduler/        # node-cron job runner + persistence
├── orchestrator/     # Message queue + session resume logic
├── telegram/         # Bot, command handlers, auth middleware
└── config.ts         # Environment config
```

## Setup

### Prerequisites

- Node.js 20+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Environment Variables

```
TELEGRAM_BOT_TOKEN=         # Required
TELEGRAM_ALLOWED_USER_IDS=  # Required, comma-separated Telegram user IDs
DATA_DIR=./data             # SQLite database location
CLAUDE_CONFIG_DIR=          # Claude Code config directory (optional)
TIMEZONE=America/New_York   # IANA timezone for scheduling
```

For Google Workspace, configure credentials in `.mcp.json` (see `.mcp.json` for the local dev setup).

### Run locally

```sh
npm install
npm run dev
```

### Deploy to Railway

The project includes a `Dockerfile` and `railway.toml` for Railway deployment. The Docker entrypoint handles:

- Writing production `.mcp.json` with compiled paths
- Seeding Claude Code and Google Workspace credentials from env vars
- Running as a non-root user

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/status` | Uptime and memory usage |
| `/new` | Start a fresh conversation (memories preserved) |
| `/reminders` | List active reminders |
