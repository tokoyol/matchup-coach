import { RIOT_TEAM_POSITION_BY_LANE, SUPPORTED_LANES, type SupportedLane } from "../data/champions.js";
import type { MatchupStats } from "../types/stats.js";
import { toRiotPatchPrefix } from "../utils/patch.js";
import { RiotApiClient } from "./riotApiClient.js";
import type { MatchupStatsStore } from "./matchupStatsStore.js";

interface AggregationBucket {
  games: number;
  wins: number;
  totalGoldDiff15: number;
  pre6Kills: number;
  pre6Deaths: number;
  runes: Map<number, number>;
  items: Map<number, number>;
}

export interface PrecomputeOptions {
  patch: string;
  lanes?: SupportedLane[];
  maxTrackedPlayers: number;
  matchesPerPlayer: number;
  maxUniqueMatches: number;
  concurrency: number;
}

export interface PrecomputeSummary {
  patch: string;
  lanes: SupportedLane[];
  playersTracked: number;
  puuidsResolved: number;
  matchIdsUnique: number;
  matchesProcessed: number;
  pairsWithGames: number;
  pairsWritten: number;
  durationMs: number;
}

function increment(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function runWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<U | null>
): Promise<U[]> {
  const workers = Math.max(1, Math.floor(concurrency));
  const results: U[] = [];
  let index = 0;

  const runWorker = async (): Promise<void> => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      try {
        const value = await handler(items[currentIndex]);
        if (value !== null) results.push(value);
      } catch {
        // Best effort during bulk precompute; skip failed items.
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => runWorker()));
  return results;
}

export class RiotPrecomputeService {
  constructor(
    private readonly riotClient: RiotApiClient,
    private readonly repository: MatchupStatsStore,
    private readonly cacheTtlMs: number
  ) {}

  async precomputeAll(options: PrecomputeOptions): Promise<PrecomputeSummary> {
    const started = Date.now();
    const riotPatchPrefix = toRiotPatchPrefix(options.patch);
    const lanes = (options.lanes?.length ? options.lanes : [...SUPPORTED_LANES]).filter((lane, idx, arr) => {
      return SUPPORTED_LANES.includes(lane) && arr.indexOf(lane) === idx;
    });
    const summonerEntries = await this.riotClient.getMasterLeagueEntries();
    const directPuuids = [
      ...new Set(summonerEntries.map((e) => e.puuid).filter((id): id is string => Boolean(id)))
    ].slice(0, options.maxTrackedPlayers);

    let puuids = directPuuids;
    if (puuids.length < options.maxTrackedPlayers) {
      const remaining = options.maxTrackedPlayers - puuids.length;
      const summonerIds = [
        ...new Set(summonerEntries.map((e) => e.summonerId).filter((id): id is string => Boolean(id)))
      ].slice(0, remaining);
      const resolved = await runWithConcurrency(summonerIds, options.concurrency, async (summonerId) => {
        return this.riotClient.getPuuidBySummonerId(summonerId);
      });
      puuids = [...new Set([...puuids, ...resolved])];
    }

    const matchIdGroups = await runWithConcurrency(puuids, options.concurrency, async (puuid) => {
      return this.riotClient.getMatchIdsByPuuid(puuid, {
        queue: 420,
        count: options.matchesPerPlayer
      });
    });

    const uniqueMatchIds = [...new Set(matchIdGroups.flat())].slice(0, options.maxUniqueMatches);
    const buckets = new Map<string, AggregationBucket>();
    let matchesProcessed = 0;

    await runWithConcurrency(uniqueMatchIds, options.concurrency, async (matchId) => {
      const [matchResult, timelineResult] = await Promise.allSettled([
        this.riotClient.getMatch(matchId),
        this.riotClient.getMatchTimeline(matchId)
      ]);
      if (matchResult.status !== "fulfilled" || timelineResult.status !== "fulfilled") return null;

      const match = matchResult.value;
      const timeline = timelineResult.value;
      const info = (match.info ?? {}) as Record<string, unknown>;
      const gameVersion = typeof info.gameVersion === "string" ? info.gameVersion : "";
      if (!gameVersion.startsWith(riotPatchPrefix)) return null;

      const participants = (info.participants ?? []) as Array<Record<string, unknown>>;

      const frames = (((timeline.info ?? {}) as Record<string, unknown>).frames ?? []) as Array<
        Record<string, unknown>
      >;
      const frame15 = frames.find((frame) => typeof frame.timestamp === "number" && frame.timestamp >= 900000);
      const pFrames = (frame15?.participantFrames ?? {}) as Record<string, Record<string, unknown>>;

      const pre6KillsByParticipant = new Map<number, number>();
      for (const frame of frames) {
        const events = (frame.events ?? []) as Array<Record<string, unknown>>;
        for (const event of events) {
          if (event.type !== "CHAMPION_KILL") continue;
          const timestamp = event.timestamp;
          if (typeof timestamp !== "number" || timestamp > 360000) continue;
          const killer = event.killerId;
          if (typeof killer === "number" && killer > 0) {
            pre6KillsByParticipant.set(killer, (pre6KillsByParticipant.get(killer) ?? 0) + 1);
          }
        }
      }

      const applySide = (
        lane: SupportedLane,
        player: Record<string, unknown>,
        enemy: Record<string, unknown>,
        playerName: string,
        enemyName: string
      ): void => {
        const key = `${options.patch}:${lane}:${playerName}:${enemyName}`;
        const current =
          buckets.get(key) ??
          ({
            games: 0,
            wins: 0,
            totalGoldDiff15: 0,
            pre6Kills: 0,
            pre6Deaths: 0,
            runes: new Map<number, number>(),
            items: new Map<number, number>()
          } satisfies AggregationBucket);

        const playerId = player.participantId as number;
        const enemyId = enemy.participantId as number;

        current.games += 1;
        if (player.win === true) current.wins += 1;

        const playerGold = pFrames[String(playerId)]?.totalGold;
        const enemyGold = pFrames[String(enemyId)]?.totalGold;
        if (typeof playerGold === "number" && typeof enemyGold === "number") {
          current.totalGoldDiff15 += playerGold - enemyGold;
        }

        current.pre6Kills += pre6KillsByParticipant.get(playerId) ?? 0;
        current.pre6Deaths += pre6KillsByParticipant.get(enemyId) ?? 0;

        const perkStyles = (player.perks as Record<string, unknown> | undefined)?.styles as
          | Array<Record<string, unknown>>
          | undefined;
        const primaryStyleSelections = (perkStyles?.[0]?.selections ?? []) as Array<Record<string, unknown>>;
        const keystoneId = primaryStyleSelections[0]?.perk;
        if (typeof keystoneId === "number") increment(current.runes, keystoneId);

        const item0 = player.item0;
        if (typeof item0 === "number" && item0 > 0) increment(current.items, item0);

        buckets.set(key, current);
      };

      for (const lane of lanes) {
        const teamPosition = RIOT_TEAM_POSITION_BY_LANE[lane];
        const lanePlayers = participants.filter((p) => p.teamPosition === teamPosition);
        if (lanePlayers.length !== 2) continue;

        const left = lanePlayers[0];
        const right = lanePlayers[1];
        const leftChampionName =
          typeof left.championName === "string"
            ? left.championName
            : typeof left.riotIdGameName === "string"
              ? left.riotIdGameName
              : "";
        const rightChampionName =
          typeof right.championName === "string"
            ? right.championName
            : typeof right.riotIdGameName === "string"
              ? right.riotIdGameName
              : "";
        if (!leftChampionName || !rightChampionName || leftChampionName === rightChampionName) continue;

        applySide(lane, left, right, leftChampionName, rightChampionName);
        applySide(lane, right, left, rightChampionName, leftChampionName);
      }
      matchesProcessed += 1;
      return true;
    });

    const expiresAt = Date.now() + this.cacheTtlMs;
    const rows = [...buckets.entries()].map(([key, bucket]) => {
      const [, lane, playerChampion, enemyChampion] = key.split(":");
      const games = bucket.games;
      const runeUsage = [...bucket.runes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([keystoneId, count]) => ({ keystoneId, count, pct: Number((count / games).toFixed(3)) }));
      const firstItemUsage = [...bucket.items.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([itemId, count]) => ({ itemId, count, pct: Number((count / games).toFixed(3)) }));

      const stats: MatchupStats = {
        patch: options.patch,
        games,
        winRate: Number((bucket.wins / games).toFixed(3)),
        goldDiff15: Math.round(bucket.totalGoldDiff15 / games),
        pre6KillRate: Number((bucket.pre6Kills / games).toFixed(3)),
        earlyDeathRate: Number((bucket.pre6Deaths / games).toFixed(3)),
        runeUsage,
        firstItemUsage,
        computedAt: new Date().toISOString()
      };

      return {
        patch: options.patch,
        lane: lane as SupportedLane,
        playerChampion,
        enemyChampion,
        stats,
        expiresAtMs: expiresAt
      };
    });

    await this.repository.upsertMany(rows);

    return {
      patch: options.patch,
      lanes,
      playersTracked: puuids.length,
      puuidsResolved: puuids.length,
      matchIdsUnique: uniqueMatchIds.length,
      matchesProcessed,
      pairsWithGames: buckets.size,
      pairsWritten: rows.length,
      durationMs: Date.now() - started
    };
  }
}
