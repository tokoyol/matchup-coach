import fs from "node:fs/promises";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";

let dbInstance: Database | null = null;

async function hasLaneColumn(db: Database): Promise<boolean> {
  const rows = (await db.all(`PRAGMA table_info(matchup_stats_cache)`)) as Array<{ name?: string }>;
  return rows.some((row) => row.name === "lane");
}

export async function getDatabase(filename: string): Promise<Database> {
  if (dbInstance) return dbInstance;

  const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(process.cwd(), filename);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  dbInstance = await open({
    filename: absolutePath,
    driver: sqlite3.Database
  });

  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS matchup_stats_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patch TEXT NOT NULL,
      lane TEXT NOT NULL DEFAULT 'top',
      player_champion TEXT NOT NULL,
      enemy_champion TEXT NOT NULL,
      stats_json TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE(patch, lane, player_champion, enemy_champion)
    );
    CREATE INDEX IF NOT EXISTS idx_matchup_stats_cache_expires_at
      ON matchup_stats_cache (expires_at);
  `);

  if (!(await hasLaneColumn(dbInstance))) {
    await dbInstance.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE matchup_stats_cache_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patch TEXT NOT NULL,
        lane TEXT NOT NULL DEFAULT 'top',
        player_champion TEXT NOT NULL,
        enemy_champion TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(patch, lane, player_champion, enemy_champion)
      );
      INSERT INTO matchup_stats_cache_v2 (patch, lane, player_champion, enemy_champion, stats_json, computed_at, expires_at)
      SELECT patch, 'top', player_champion, enemy_champion, stats_json, computed_at, expires_at
      FROM matchup_stats_cache;
      DROP TABLE matchup_stats_cache;
      ALTER TABLE matchup_stats_cache_v2 RENAME TO matchup_stats_cache;
      CREATE INDEX IF NOT EXISTS idx_matchup_stats_cache_expires_at
        ON matchup_stats_cache (expires_at);
      COMMIT;
    `);
  }

  return dbInstance;
}
