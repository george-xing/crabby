# Crabby

Personal AI assistant that runs on Telegram, powered by Claude Code CLI.

Crabby spawns Claude Code as a subprocess for each conversation, giving it access to MCP servers for persistent memory, Google Workspace, and scheduling. Sessions persist across messages with automatic context recovery when sessions reset.

## Features

- **Conversational AI** — Claude Code CLI with streaming responses to Telegram
- **Persistent memory** — Remembers facts, preferences, and contacts across sessions
- **Google Workspace** — Gmail, Calendar, Drive, Sheets, Docs via MCP server
- **Resy restaurant reservations** — Search, book, and cancel reservations via natural language
- **Auto-booking monitors** — Casual polling and snipe mode for hard-to-get reservations
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
                                          - crabby-resy (Resy API + SQLite)
```

## Project Structure

```
src/
├── claude/           # Claude Code subprocess, session management, streaming
├── mcp/
│   ├── memory-server/    # remember, recall, forget tools
│   ├── gws-server/       # Google Workspace integration
│   ├── scheduler-server/ # reminders and briefings
│   └── resy-server/      # restaurant reservation tools
├── memory/           # SQLite-backed memory storage
├── resy/             # Resy API client, auth, and booking monitor
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

For Resy, run `scripts/setup-resy.sh` or set these additional variables:

```
RESY_API_KEY=               # Resy API key
RESY_EMAIL=                 # Resy account email
RESY_PASSWORD=              # Resy account password
```

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

## Resy Integration

Crabby can search, book, and manage restaurant reservations on [Resy](https://resy.com) through natural conversation. The MCP server exposes 9 tools to Claude:

| Tool | Description |
|------|-------------|
| `resy_search` | Search available tables by date, party size, and location |
| `resy_find_venue` | Look up a restaurant by name to get its venue ID |
| `resy_slot_details` | View cancellation fees, deposits, and payment info before booking |
| `resy_book` | Book a reservation (asks for user confirmation) |
| `resy_my_reservations` | List upcoming reservations |
| `resy_cancel` | Cancel a reservation (asks for user confirmation) |
| `resy_create_monitor` | Set up an auto-booking monitor (casual or snipe mode) |
| `resy_list_monitors` | Show active monitors |
| `resy_cancel_monitor` | Disable a monitor |

### Auto-booking monitors

Monitors watch for open tables and book automatically when a match is found. Two modes are available:

- **Casual mode** — polls every 60 seconds looking for cancellation pickups within a date range and time window
- **Snipe mode** — schedules a cron job at the restaurant's reservation drop time, then polls aggressively (every 1 second for 30 seconds) to grab tables the instant they're released

Monitors support filters for day-of-week, time windows, and date ranges. Successful bookings trigger a Telegram notification. Resy credentials are optional — Crabby works without them but the reservation tools won't be available.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/status` | Uptime and memory usage |
| `/new` | Start a fresh conversation (memories preserved) |
| `/reminders` | List active reminders |
