import {
  RIOT_TEAM_POSITION_BY_LANE,
  championKey,
  normalizeChampionName,
  type SupportedLane
} from "../data/champions.js";
import type { MatchupStats } from "../types/stats.js";
import { toRiotPatchPrefix } from "../utils/patch.js";
import { RiotApiClient } from "./riotApiClient.js";
import { MatchupStatsRepository } from "./matchupStatsRepository.js";

interface GetStatsInput {
  playerChampion: string;
  enemyChampion: string;
  lane?: SupportedLane;
  patch: string;
  maxTrackedPlayers?: number;
  maxMatchesPerPlayer?: number;
}

interface CacheEntry {
  value: MatchupStats;
  expiresAt: number;
}

function increment(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export class RiotMatchupStatsService {
  private cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;

  constructor(
    private readonly riotClient: RiotApiClient,
    private readonly options?: { cacheTtlMs?: number; repository?: MatchupStatsRepository }
  ) {
    this.cacheTtlMs = options?.cacheTtlMs ?? 10 * 60 * 1000;
  }

  async getMatchupStats(input: GetStatsInput): Promise<MatchupStats | null> {
    const riotPatchPrefix = toRiotPatchPrefix(input.patch);
    const lane = input.lane ?? "top";
    const cacheKey = `${input.patch}:${lane}:${input.playerChampion}:${input.enemyChampion}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    if (this.options?.repository) {
      const persisted = await this.options.repository.get(
        input.patch,
        lane,
        input.playerChampion,
        input.enemyChampion,
        now
      );
      if (persisted) {
        this.cache.set(cacheKey, { value: persisted, expiresAt: now + this.cacheTtlMs });
        return persisted;
      }
    }

    const playerChampionKey = championKey(input.playerChampion);
    const enemyChampionKey = championKey(input.enemyChampion);
    const teamPosition = RIOT_TEAM_POSITION_BY_LANE[lane];

    const entries = await this.riotClient.getMasterLeagueEntries();
    const maxTracked = input.maxTrackedPlayers ?? 25;
    const directPuuids = [...new Set(entries.map((e) => e.puuid).filter((id): id is string => Boolean(id)))].slice(
      0,
      maxTracked
    );

    let puuids = directPuuids;
    if (puuids.length < maxTracked) {
      const remaining = maxTracked - puuids.length;
      const summonerIds = [
        ...new Set(entries.map((e) => e.summonerId).filter((id): id is string => Boolean(id)))
      ].slice(0, remaining);

      const resolved = (
        await Promise.allSettled(summonerIds.map((id) => this.riotClient.getPuuidBySummonerId(id)))
      )
        .filter((item): item is PromiseFulfilledResult<string> => item.status === "fulfilled")
        .map((item) => item.value);

      puuids = [...new Set([...puuids, ...resolved])];
    }

    const matchIdsByPlayer = await Promise.all(
      puuids.map((puuid) =>
        this.riotClient.getMatchIdsByPuuid(puuid, {
          queue: 420,
          count: input.maxMatchesPerPlayer ?? 10
        })
      )
    );
    const matchIds = [...new Set(matchIdsByPlayer.flat())].slice(0, 150);

    let games = 0;
    let wins = 0;
    let totalGoldDiff15 = 0;
    let pre6Kills = 0;
    let pre6Deaths = 0;
    const runes = new Map<number, number>();
    const firstItems = new Map<number, number>();

    for (const matchId of matchIds) {
      const [matchResult, timelineResult] = await Promise.allSettled([
        this.riotClient.getMatch(matchId),
        this.riotClient.getMatchTimeline(matchId)
      ]);
      if (matchResult.status !== "fulfilled" || timelineResult.status !== "fulfilled") continue;

      const match = matchResult.value;
      const timeline = timelineResult.value;
      const info = (match.info ?? {}) as Record<string, unknown>;
      const gameVersion = typeof info.gameVersion === "string" ? info.gameVersion : "";
      if (!gameVersion.startsWith(riotPatchPrefix)) continue;

      const participants = (info.participants ?? []) as Array<Record<string, unknown>>;
      const lanePlayers = participants.filter((p) => p.teamPosition === teamPosition);
      if (lanePlayers.length !== 2) continue;

      const one = lanePlayers[0];
      const two = lanePlayers[1];
      const oneChampionName = normalizeChampionName(String(one.championName ?? ""));
      const twoChampionName = normalizeChampionName(String(two.championName ?? ""));
      const oneChampionKey = championKey(oneChampionName);
      const twoChampionKey = championKey(twoChampionName);

      const isDirectPair =
        (oneChampionKey === playerChampionKey && twoChampionKey === enemyChampionKey) ||
        (oneChampionKey === enemyChampionKey && twoChampionKey === playerChampionKey);
      if (!isDirectPair) continue;

      const playerTop = oneChampionKey === playerChampionKey ? one : two;
      const enemyTop = oneChampionKey === enemyChampionKey ? one : two;

      games += 1;
      if (playerTop.win === true) wins += 1;

      const playerId = playerTop.participantId as number;
      const enemyId = enemyTop.participantId as number;
      if (!playerId || !enemyId) continue;

      const frames = (((timeline.info ?? {}) as Record<string, unknown>).frames ?? []) as Array<
        Record<string, unknown>
      >;
      const frame15 = frames.find((frame) => typeof frame.timestamp === "number" && frame.timestamp >= 900000);
      if (frame15) {
        const pFrames = (frame15.participantFrames ?? {}) as Record<string, Record<string, unknown>>;
        const playerGold = pFrames[String(playerId)]?.totalGold;
        const enemyGold = pFrames[String(enemyId)]?.totalGold;
        if (typeof playerGold === "number" && typeof enemyGold === "number") {
          totalGoldDiff15 += playerGold - enemyGold;
        }
      }

      const perkStyles = (playerTop.perks as Record<string, unknown> | undefined)?.styles as
        | Array<Record<string, unknown>>
        | undefined;
      const primaryStyleSelections = (perkStyles?.[0]?.selections ?? []) as Array<Record<string, unknown>>;
      const keystoneId = primaryStyleSelections[0]?.perk;
      if (typeof keystoneId === "number") increment(runes, keystoneId);

      const item0 = playerTop.item0;
      if (typeof item0 === "number" && item0 > 0) increment(firstItems, item0);

      for (const frame of frames) {
        const events = (frame.events ?? []) as Array<Record<string, unknown>>;
        for (const event of events) {
          if (event.type !== "CHAMPION_KILL") continue;
          const timestamp = event.timestamp;
          if (typeof timestamp !== "number" || timestamp > 360000) continue;
          if (event.killerId === playerId) pre6Kills += 1;
          if (event.victimId === playerId) pre6Deaths += 1;
        }
      }
    }

    if (games === 0) return null;

    const runeUsage = [...runes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([keystoneId, count]) => ({ keystoneId, count, pct: Number((count / games).toFixed(3)) }));

    const firstItemUsage = [...firstItems.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([itemId, count]) => ({ itemId, count, pct: Number((count / games).toFixed(3)) }));

    const stats: MatchupStats = {
      patch: input.patch,
      games,
      winRate: Number((wins / games).toFixed(3)),
      goldDiff15: Math.round(totalGoldDiff15 / games),
      pre6KillRate: Number((pre6Kills / games).toFixed(3)),
      earlyDeathRate: Number((pre6Deaths / games).toFixed(3)),
      runeUsage,
      firstItemUsage,
      computedAt: new Date().toISOString()
    };

    const expiresAt = now + this.cacheTtlMs;
    this.cache.set(cacheKey, { value: stats, expiresAt });
    if (this.options?.repository) {
      await this.options.repository.upsert(
        input.patch,
        lane,
        input.playerChampion,
        input.enemyChampion,
        stats,
        expiresAt
      );
    }
    return stats;
  }
}
