import Database from "better-sqlite3";
import path from "node:path";

let db: Database.Database;

export interface MemoryRow {
  id: number;
  category: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  access_count: number;
}

export function initMemoryDb(dataDir: string): Database.Database {
  const dbPath = path.join(dataDir, "crabby.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(category, key)
    )
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Memory DB not initialized");
  return db;
}

export function remember(category: string, key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO memories (category, key, value)
       VALUES (?, ?, ?)
       ON CONFLICT(category, key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    )
    .run(category, key, value, value);
}

export function recall(query: string): MemoryRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM memories
       WHERE key LIKE ? OR value LIKE ? OR category LIKE ?
       ORDER BY access_count DESC, updated_at DESC
       LIMIT 20`,
    )
    .all(`%${query}%`, `%${query}%`, `%${query}%`) as MemoryRow[];
}

export function listMemories(category?: string): MemoryRow[] {
  if (category) {
    return getDb()
      .prepare(
        `SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC`,
      )
      .all(category) as MemoryRow[];
  }
  return getDb()
    .prepare(`SELECT * FROM memories ORDER BY category, updated_at DESC`)
    .all() as MemoryRow[];
}

export function forget(category: string, key: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM memories WHERE category = ? AND key = ?`)
    .run(category, key);
  return result.changes > 0;
}

export function getPreferences(): MemoryRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM memories WHERE category = 'preference' ORDER BY updated_at DESC`,
    )
    .all() as MemoryRow[];
}
