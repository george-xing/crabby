#!/usr/bin/env node
/**
 * MCP server for scheduling reminders and briefings.
 * Claude uses these tools to let the user set reminders, schedule briefings, etc.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const dbPath = path.join(DATA_DIR, "crabby.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Ensure table exists (may already exist from main process)
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    cron_expression TEXT,
    run_at TEXT,
    message TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const server = new McpServer({
  name: "crabby-scheduler",
  version: "0.1.0",
});

server.tool(
  "set_reminder",
  "Set a one-time reminder for the user. The reminder will be delivered as a Telegram message at the specified time.",
  {
    message: z.string().describe("What to remind the user about"),
    remind_at: z.string().describe("When to deliver the reminder (ISO 8601 datetime, e.g. '2025-01-15T09:00:00-05:00')"),
    chat_id: z.number().describe("The Telegram chat ID to deliver the reminder to"),
  },
  async ({ message, remind_at, chat_id }) => {
    const result = db
      .prepare(
        `INSERT INTO scheduled_jobs (chat_id, type, run_at, message) VALUES (?, 'reminder', ?, ?)`,
      )
      .run(chat_id, remind_at, message);

    return {
      content: [{
        type: "text" as const,
        text: `Reminder #${result.lastInsertRowid} set for ${remind_at}: "${message}"`,
      }],
    };
  },
);

server.tool(
  "set_recurring_reminder",
  "Set a recurring reminder using a cron expression. Common patterns: '0 9 * * 1-5' = weekdays at 9am, '0 8 * * *' = daily at 8am, '0 */2 * * *' = every 2 hours.",
  {
    message: z.string().describe("What to remind the user about"),
    cron_expression: z.string().describe("Cron expression (minute hour day-of-month month day-of-week)"),
    chat_id: z.number().describe("The Telegram chat ID"),
  },
  async ({ message, cron_expression, chat_id }) => {
    const result = db
      .prepare(
        `INSERT INTO scheduled_jobs (chat_id, type, cron_expression, message) VALUES (?, 'recurring', ?, ?)`,
      )
      .run(chat_id, cron_expression, message);

    return {
      content: [{
        type: "text" as const,
        text: `Recurring reminder #${result.lastInsertRowid} created with schedule "${cron_expression}": "${message}"`,
      }],
    };
  },
);

server.tool(
  "set_morning_briefing",
  "Set up a daily morning briefing. Claude will generate a summary of calendar events, emails, and relevant info at the scheduled time.",
  {
    cron_expression: z.string().optional().default("0 8 * * *").describe("Cron expression, default '0 8 * * *' (daily at 8am)"),
    custom_prompt: z.string().optional().describe("Custom prompt for the briefing. Defaults to calendar + email summary."),
    chat_id: z.number().describe("The Telegram chat ID"),
  },
  async ({ cron_expression, custom_prompt, chat_id }) => {
    // Disable any existing briefing for this chat
    db.prepare(
      `UPDATE scheduled_jobs SET enabled = 0 WHERE chat_id = ? AND type = 'briefing'`,
    ).run(chat_id);

    const message = custom_prompt || "Give me my morning briefing: today's calendar events, any important emails, and a quick weather summary.";
    const result = db
      .prepare(
        `INSERT INTO scheduled_jobs (chat_id, type, cron_expression, message) VALUES (?, 'briefing', ?, ?)`,
      )
      .run(chat_id, cron_expression, message);

    return {
      content: [{
        type: "text" as const,
        text: `Morning briefing #${result.lastInsertRowid} set with schedule "${cron_expression}". Any previous briefing for this chat has been replaced.`,
      }],
    };
  },
);

server.tool(
  "list_reminders",
  "List all active reminders and scheduled jobs for a chat.",
  {
    chat_id: z.number().describe("The Telegram chat ID"),
  },
  async ({ chat_id }) => {
    const rows = db
      .prepare(
        `SELECT id, type, cron_expression, run_at, message, created_at
         FROM scheduled_jobs WHERE chat_id = ? AND enabled = 1
         ORDER BY created_at`,
      )
      .all(chat_id) as Array<{
        id: number;
        type: string;
        cron_expression: string | null;
        run_at: string | null;
        message: string;
        created_at: string;
      }>;

    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No active reminders or scheduled jobs." }] };
    }

    const lines = rows.map((r) => {
      const schedule = r.cron_expression || r.run_at || "unknown";
      return `#${r.id} [${r.type}] schedule: ${schedule} — "${r.message}"`;
    });

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "cancel_reminder",
  "Cancel/disable a scheduled reminder or job by its ID.",
  {
    id: z.number().describe("The job ID to cancel"),
  },
  async ({ id }) => {
    const result = db
      .prepare("UPDATE scheduled_jobs SET enabled = 0 WHERE id = ?")
      .run(id);

    if (result.changes > 0) {
      return { content: [{ type: "text" as const, text: `Job #${id} has been cancelled.` }] };
    }
    return { content: [{ type: "text" as const, text: `Job #${id} not found.` }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
