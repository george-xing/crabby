import { getDb } from "../memory/db.js";
import { logger } from "../utils/logger.js";

interface ScheduledJobRow {
  id: number;
  chat_id: number;
  type: "reminder" | "briefing" | "recurring";
  cron_expression: string | null;
  run_at: string | null;
  message: string;
  enabled: number; // SQLite stores booleans as 0/1
  created_at: string;
}

export interface ScheduledJob {
  id: number;
  chat_id: number;
  type: "reminder" | "briefing" | "recurring";
  cron_expression: string | null;
  run_at: string | null;
  message: string;
  enabled: boolean;
  created_at: string;
}

function toJob(row: ScheduledJobRow): ScheduledJob {
  return { ...row, enabled: !!row.enabled };
}

export function initSchedulerDb(): void {
  getDb().exec(`
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
  logger.info("Scheduler DB initialized");
}

export function createJob(
  chatId: number,
  type: ScheduledJob["type"],
  message: string,
  options: { cronExpression?: string; runAt?: string },
): ScheduledJob {
  const result = getDb()
    .prepare(
      `INSERT INTO scheduled_jobs (chat_id, type, cron_expression, run_at, message)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(chatId, type, options.cronExpression || null, options.runAt || null, message);

  return getJob(result.lastInsertRowid as number)!;
}

export function getJob(id: number): ScheduledJob | undefined {
  const row = getDb()
    .prepare("SELECT * FROM scheduled_jobs WHERE id = ?")
    .get(id) as ScheduledJobRow | undefined;

  return row ? toJob(row) : undefined;
}

export function getActiveJobs(): ScheduledJob[] {
  const rows = getDb()
    .prepare("SELECT * FROM scheduled_jobs WHERE enabled = 1 ORDER BY created_at")
    .all() as ScheduledJobRow[];

  return rows.map(toJob);
}

export function getJobsForChat(chatId: number): ScheduledJob[] {
  const rows = getDb()
    .prepare("SELECT * FROM scheduled_jobs WHERE chat_id = ? AND enabled = 1 ORDER BY created_at")
    .all(chatId) as ScheduledJobRow[];

  return rows.map(toJob);
}

export function disableJob(id: number): boolean {
  const result = getDb()
    .prepare("UPDATE scheduled_jobs SET enabled = 0 WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function deleteJob(id: number): boolean {
  const result = getDb()
    .prepare("DELETE FROM scheduled_jobs WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function getDueReminders(): ScheduledJob[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM scheduled_jobs
       WHERE type = 'reminder' AND enabled = 1 AND run_at IS NOT NULL
         AND datetime(run_at) <= datetime('now')
       ORDER BY run_at`,
    )
    .all() as ScheduledJobRow[];

  return rows.map(toJob);
}
