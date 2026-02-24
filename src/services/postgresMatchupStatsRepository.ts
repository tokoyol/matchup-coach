import type { Pool } from "pg";
import type { SupportedLane } from "../data/champions.js";
import type { MatchupStats } from "../types/stats.js";
import type { MatchupStatsStore, MatchupStatsUpsertRow } from "./matchupStatsStore.js";

interface MatchupCacheRow {
  stats_json: MatchupStats;
}

interface CacheOverviewRow {
  total_count: string | number;
  fresh_count: string | number;
  stale_count: string | number;
  latest_computed_at: string | null;
}

interface CachedPairRow {
  lane: SupportedLane;
  player_champion: string;
  enemy_champion: string;
  computed_at: string;
  expires_at: string | number;
}

export class PostgresMatchupStatsRepository implements MatchupStatsStore {
  constructor(private readonly pool: Pool) {}

  async get(
    patch: string,
    lane: SupportedLane,
    playerChampion: string,
    enemyChampion: string
  ): Promise<MatchupStats | null> {
    const result = await this.pool.query<MatchupCacheRow>(
      `
        SELECT stats_json
        FROM matchup_stats_cache
        WHERE patch = $1 AND lane = $2 AND player_champion = $3 AND enemy_champion = $4
        LIMIT 1
      `,
      [patch, lane, playerChampion, enemyChampion]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0]?.stats_json ?? null;
  }

  async upsert(
    patch: string,
    lane: SupportedLane,
    playerChampion: string,
    enemyChampion: string,
    stats: MatchupStats,
    expiresAtMs: number
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO matchup_stats_cache (
          patch, lane, player_champion, enemy_champion, stats_json, computed_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7)
        ON CONFLICT (patch, lane, player_champion, enemy_champion)
        DO UPDATE SET
          stats_json = EXCLUDED.stats_json,
          computed_at = EXCLUDED.computed_at,
          expires_at = EXCLUDED.expires_at
      `,
      [patch, lane, playerChampion, enemyChampion, JSON.stringify(stats), stats.computedAt, expiresAtMs]
    );
  }

  async upsertMany(rows: MatchupStatsUpsertRow[]): Promise<void> {
    if (rows.length === 0) return;

    const chunkSize = 200;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        for (const row of chunk) {
          await client.query(
            `
              INSERT INTO matchup_stats_cache (
                patch, lane, player_champion, enemy_champion, stats_json, computed_at, expires_at
              ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7)
              ON CONFLICT (patch, lane, player_champion, enemy_champion)
              DO UPDATE SET
                stats_json = EXCLUDED.stats_json,
                computed_at = EXCLUDED.computed_at,
                expires_at = EXCLUDED.expires_at
            `,
            [
              row.patch,
              row.lane,
              row.playerChampion,
              row.enemyChampion,
              JSON.stringify(row.stats),
              row.stats.computedAt,
              row.expiresAtMs
            ]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
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
    const result = await this.pool.query<CacheOverviewRow>(
      `
        SELECT
          COUNT(*) AS total_count,
          COALESCE(SUM(CASE WHEN expires_at > $1 THEN 1 ELSE 0 END), 0) AS fresh_count,
          COALESCE(SUM(CASE WHEN expires_at <= $1 THEN 1 ELSE 0 END), 0) AS stale_count,
          MAX(computed_at)::text AS latest_computed_at
        FROM matchup_stats_cache
        WHERE patch = $2
          AND ($3::text IS NULL OR lane = $3)
      `,
      [nowMs, patch, lane ?? null]
    );

    const row = result.rows[0];
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
    const lane = options?.lane ?? null;
    const limit = Math.max(1, Math.floor(options?.limit ?? 500));
    const freshOnly = options?.freshOnly ?? false;
    const nowMs = options?.nowMs ?? Date.now();

    const result = await this.pool.query<CachedPairRow>(
      `
        SELECT lane, player_champion, enemy_champion, computed_at::text, expires_at
        FROM matchup_stats_cache
        WHERE patch = $1
          AND ($2::text IS NULL OR lane = $2)
          AND ($3::boolean = false OR expires_at > $4)
        ORDER BY computed_at DESC
        LIMIT $5
      `,
      [patch, lane, freshOnly, nowMs, limit]
    );

    return result.rows.map((row) => ({
      lane: row.lane,
      playerChampion: row.player_champion,
      enemyChampion: row.enemy_champion,
      computedAt: row.computed_at,
      expiresAt: Number(row.expires_at),
      fresh: Number(row.expires_at) > nowMs
    }));
  }

  async listChampionsByLane(patch: string, lane: SupportedLane, limit = 300): Promise<string[]> {
    const result = await this.pool.query<{ champion: string }>(
      `
        SELECT player_champion AS champion
        FROM matchup_stats_cache
        WHERE patch = $1 AND lane = $2
        UNION
        SELECT enemy_champion AS champion
        FROM matchup_stats_cache
        WHERE patch = $1 AND lane = $2
        LIMIT $3
      `,
      [patch, lane, Math.max(1, Math.floor(limit))]
    );

    return result.rows.map((row) => row.champion).sort((a, b) => a.localeCompare(b));
  }
}
