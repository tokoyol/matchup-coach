import type { SupportedLane } from "../data/champions.js";
import type { MatchupStats } from "../types/stats.js";

export interface MatchupStatsUpsertRow {
  patch: string;
  lane: SupportedLane;
  playerChampion: string;
  enemyChampion: string;
  stats: MatchupStats;
  expiresAtMs: number;
}

export interface MatchupStatsStore {
  get(
    patch: string,
    lane: SupportedLane,
    playerChampion: string,
    enemyChampion: string,
    nowMs?: number
  ): Promise<MatchupStats | null>;
  upsert(
    patch: string,
    lane: SupportedLane,
    playerChampion: string,
    enemyChampion: string,
    stats: MatchupStats,
    expiresAtMs: number
  ): Promise<void>;
  upsertMany(rows: MatchupStatsUpsertRow[]): Promise<void>;
  getCacheOverview(
    patch: string,
    lane?: SupportedLane,
    nowMs?: number
  ): Promise<{
    totalCount: number;
    freshCount: number;
    staleCount: number;
    latestComputedAt: string | null;
  }>;
  listCachedPairs(
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
  >;
  listChampionsByLane(patch: string, lane: SupportedLane, limit?: number): Promise<string[]>;
}
