import Database from "better-sqlite3";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let db: Database.Database;

interface SessionRow {
  chat_id: number;
  session_id: string;
  updated_at: string;
  message_count: number;
}

// No expiry — sessions persist indefinitely. If --resume fails, the
// orchestrator retries with a fresh session automatically.

export function initSessionManager() {
  const dbPath = path.join(config.dataDir, "crabby.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Add message_count column if upgrading from older schema
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  logger.info("Session manager initialized");
}

export function getSessionId(chatId: number): string | null {
  const row = db
    .prepare("SELECT session_id, updated_at FROM sessions WHERE chat_id = ?")
    .get(chatId) as SessionRow | undefined;

  if (!row) return null;
  return row.session_id;
}

export function saveSessionId(chatId: number, sessionId: string) {
  db.prepare(
    `INSERT INTO sessions (chat_id, session_id, updated_at, message_count)
     VALUES (?, ?, datetime('now'), 1)
     ON CONFLICT(chat_id) DO UPDATE SET
       session_id = ?,
       updated_at = datetime('now'),
       message_count = CASE WHEN session_id = ? THEN message_count + 1 ELSE 1 END`,
  ).run(chatId, sessionId, sessionId, sessionId);
}

export function getMessageCount(chatId: number): number {
  const row = db
    .prepare("SELECT message_count FROM sessions WHERE chat_id = ?")
    .get(chatId) as { message_count: number } | undefined;
  return row?.message_count || 0;
}

export function clearSession(chatId: number): void {
  db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
  logger.info({ chatId }, "Session cleared");
}
