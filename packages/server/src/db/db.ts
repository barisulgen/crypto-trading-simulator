import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

function migrationFiles(): { version: number; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.split('_')[0]), sql: readFileSync(MIGRATIONS_DIR + f, 'utf8') }));
}

/** Open (creating if needed) the database and apply pending migrations by PRAGMA user_version. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = migrationFiles().filter((m) => m.version > current);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  if (current === 0) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('test_data', '1')").run();
  }
  return db;
}

/** The current season's id; creates 'Season 1' on first run. */
export function currentSeasonId(db: Db): number {
  const row = db.prepare('SELECT id FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as
    | { id: number }
    | undefined;
  if (row) return row.id;
  const info = db
    .prepare('INSERT INTO seasons (name, started_at) VALUES (?, ?)')
    .run('Season 1', Date.now());
  return Number(info.lastInsertRowid);
}
