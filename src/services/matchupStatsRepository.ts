import type { Database } from "sqlite";
import type { SupportedLane } from "../data/champions.js";
import type { MatchupStats } from "../types/stats.js";

interface MatchupCacheRow {
  stats_json: string;
  expires_at: number;
}

interface CacheOverviewRow {
  total_count: number;
  fresh_count: number;
  stale_count: number;
  latest_computed_at: string | null;
}

interface CachedPairRow {
  lane: SupportedLane;
  player_champion: string;
  enemy_champion: string;
  computed_at: string;
  expires_at: number;
}

interface UpsertRow {
  patch: string;
  lane: SupportedLane;
  playerChampion: string;
  enemyChampion: string;
  stats: MatchupStats;
  expiresAtMs: number;
}

export class MatchupStatsRepository {
  constructor(private readonly db: Database) {}

  async get(
    patch: string,
    lane: SupportedLane,
    playerChampion: string,
    enemyChampion: string,
    _nowMs = Date.now()
  ): Promise<MatchupStats | null> {
    const row = await this.db.get<MatchupCacheRow>(
      `
        SELECT stats_json, expires_at
        FROM matchup_stats_cache
        WHERE patch = ? AND lane = ? AND player_champion = ? AND enemy_champion = ?
        LIMIT 1
      `,
      [patch, lane, playerChampion, enemyChampion]
    );

    if (!row) return null;

    try {
      return JSON.parse(row.stats_json) as MatchupStats;
    } catch {
      return null;
    }
  }

  async upsert(
    patch: string,
    lane: SupportedLane,
    playerChampion: string,
    enemyChampion: string,
    stats: MatchupStats,
    expiresAtMs: number
  ): Promise<void> {
    await this.db.run(
      `
        INSERT INTO matchup_stats_cache (
          patch, lane, player_champion, enemy_champion, stats_json, computed_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(patch, lane, player_champion, enemy_champion)
        DO UPDATE SET
          stats_json = excluded.stats_json,
          computed_at = excluded.computed_at,
          expires_at = excluded.expires_at
      `,
      [patch, lane, playerChampion, enemyChampion, JSON.stringify(stats), stats.computedAt, expiresAtMs]
    );
  }

  async upsertMany(rows: UpsertRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.exec("BEGIN TRANSACTION");
    try {
      for (const row of rows) {
        await this.upsert(
          row.patch,
          row.lane,
          row.playerChampion,
          row.enemyChampion,
          row.stats,
          row.expiresAtMs
        );
      }
      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async pruneExpired(nowMs = Date.now()): Promise<void> {
    await this.db.run(`DELETE FROM matchup_stats_cache WHERE expires_at <= ?`, [nowMs]);
  }

  async getCacheOverview(
    patch: string,
    lane?: SupportedLane,
    nowMs = Date.now()
  ): Promise<{
    totalCount: number;
    freshCount: number;
    staleCount: number;
    latestComputedAt: string | null;
  }> {
    const row = await this.db.get<CacheOverviewRow>(
      `
        SELECT
          COUNT(*) AS total_count,
          SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) AS fresh_count,
          SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) AS stale_count,
          MAX(computed_at) AS latest_computed_at
        FROM matchup_stats_cache
        WHERE patch = ?
          AND (? IS NULL OR lane = ?)
      `,
      [nowMs, nowMs, patch, lane ?? null, lane ?? null]
    );

    return {
      totalCount: Number(row?.total_count ?? 0),
      freshCount: Number(row?.fresh_count ?? 0),
      staleCount: Number(row?.stale_count ?? 0),
      latestComputedAt: row?.latest_computed_at ?? null
    };
  }

  async listCachedPairs(
    patch: string,
    options?: { lane?: SupportedLane; limit?: number; freshOnly?: boolean; nowMs?: number }
  ): Promise<
    Array<{
      lane: SupportedLane;
      playerChampion: string;
      enemyChampion: string;
      computedAt: string;
      expiresAt: number;
      fresh: boolean;
    }>
  > {
    const nowMs = options?.nowMs ?? Date.now();
    const lane = options?.lane ?? null;
    const limit = Math.max(1, Math.floor(options?.limit ?? 500));
    const freshOnly = options?.freshOnly ?? false;

    const rows = await this.db.all<CachedPairRow[]>(
      `
        SELECT lane, player_champion, enemy_champion, computed_at, expires_at
        FROM matchup_stats_cache
        WHERE patch = ?
          AND (? IS NULL OR lane = ?)
          AND (? = 0 OR expires_at > ?)
        ORDER BY computed_at DESC
        LIMIT ?
      `,
      [patch, lane, lane, freshOnly ? 1 : 0, nowMs, limit]
    );

    return rows.map((row) => ({
      lane: row.lane,
      playerChampion: row.player_champion,
      enemyChampion: row.enemy_champion,
      computedAt: row.computed_at,
      expiresAt: row.expires_at,
      fresh: row.expires_at > nowMs
    }));
  }

  async listChampionsByLane(patch: string, lane: SupportedLane, limit = 300): Promise<string[]> {
    const rows = (await this.db.all(
      `
        SELECT player_champion AS champion
        FROM matchup_stats_cache
        WHERE patch = ? AND lane = ?
        UNION
        SELECT enemy_champion AS champion
        FROM matchup_stats_cache
        WHERE patch = ? AND lane = ?
        LIMIT ?
      `,
      [patch, lane, patch, lane, Math.max(1, Math.floor(limit))]
    )) as Array<{ champion: string }>;

    return rows.map((row) => row.champion).sort((a, b) => a.localeCompare(b));
  }
}
