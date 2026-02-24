import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import {
  RIOT_TEAM_POSITION_BY_LANE,
  SUPPORTED_LANES,
  normalizeChampionName,
  normalizeLane,
  type SupportedLane
} from "../data/champions.js";
import { getPostgresPool } from "../db/postgres.js";
import { getDatabase } from "../db/sqlite.js";
import { MatchupStatsRepository } from "../services/matchupStatsRepository.js";
import { PostgresMatchupStatsRepository } from "../services/postgresMatchupStatsRepository.js";
import type { MatchupStatsStore } from "../services/matchupStatsStore.js";
import { toRiotPatchPrefix } from "../utils/patch.js";

interface CliOptions {
  patch: string;
  lanes: SupportedLane[];
  maxPlayers: number;
  matchesPerPlayer: number;
  maxUniqueMatches: number;
  resume: boolean;
  checkpointPath: string;
  checkpointEvery: number;
}

interface LeagueEntry {
  puuid?: string;
}

interface AggregationBucket {
  games: number;
  wins: number;
  totalGoldDiff15: number;
  pre6Kills: number;
  pre6Deaths: number;
  runes: Map<number, number>;
  items: Map<number, number>;
}

interface SerializedAggregationBucket {
  games: number;
  wins: number;
  totalGoldDiff15: number;
  pre6Kills: number;
  pre6Deaths: number;
  runes: Array<[number, number]>;
  items: Array<[number, number]>;
}

interface ScrapeCheckpoint {
  version: 1;
  savedAt: string;
  options: {
    patch: string;
    lanes: SupportedLane[];
    maxPlayers: number;
    matchesPerPlayer: number;
    maxUniqueMatches: number;
  };
  phase: "match_ids" | "matches";
  puuids: string[];
  nextPlayerIndex: number;
  allMatchIds: string[];
  uniqueMatchIds: string[];
  nextMatchIndex: number;
  matchesProcessed: number;
  buckets: Record<string, SerializedAggregationBucket>;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

class DualWindowRateLimiter {
  private oneSecondWindow: number[] = [];
  private twoMinuteWindow: number[] = [];

  constructor(
    private readonly oneSecondLimit: number,
    private readonly oneSecondMs: number,
    private readonly twoMinuteLimit: number,
    private readonly twoMinuteMs: number
  ) {}

  private prune(now: number): void {
    while (this.oneSecondWindow.length > 0 && now - this.oneSecondWindow[0] >= this.oneSecondMs) {
      this.oneSecondWindow.shift();
    }
    while (this.twoMinuteWindow.length > 0 && now - this.twoMinuteWindow[0] >= this.twoMinuteMs) {
      this.twoMinuteWindow.shift();
    }
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      this.prune(now);

      const oneSecondOk = this.oneSecondWindow.length < this.oneSecondLimit;
      const twoMinuteOk = this.twoMinuteWindow.length < this.twoMinuteLimit;
      if (oneSecondOk && twoMinuteOk) {
        this.oneSecondWindow.push(now);
        this.twoMinuteWindow.push(now);
        return;
      }

      const waitOneSecond =
        this.oneSecondWindow.length >= this.oneSecondLimit
          ? this.oneSecondMs - (now - this.oneSecondWindow[0])
          : Number.POSITIVE_INFINITY;
      const waitTwoMinute =
        this.twoMinuteWindow.length >= this.twoMinuteLimit
          ? this.twoMinuteMs - (now - this.twoMinuteWindow[0])
          : Number.POSITIVE_INFINITY;
      await new Promise((resolve) => setTimeout(resolve, Math.max(20, Math.min(waitOneSecond, waitTwoMinute))));
    }
  }
}

const limiter = new DualWindowRateLimiter(20, 1000, 100, 120000);

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const read = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
    return fallback;
  };
  const has = (name: string): boolean => args.includes(`--${name}`);

  const patch = read("patch", env.CURRENT_PATCH);
  const lanesRaw = read("lanes", "top,jungle,mid,adc,support");
  const lanes = lanesRaw
    .split(",")
    .map((lane) => normalizeLane(lane))
    .filter((lane, idx, arr) => arr.indexOf(lane) === idx);
  const maxPlayers = Number(read("maxPlayers", "80"));
  const matchesPerPlayer = Number(read("matchesPerPlayer", "20"));
  const maxUniqueMatches = Number(read("maxUniqueMatches", "2000"));
  const checkpointEvery = Number(read("checkpointEvery", "20"));
  const checkpointPath = read("checkpointPath", "./data/scrape-matchups-checkpoint.json");

  return {
    patch,
    lanes: lanes.length > 0 ? lanes : [...SUPPORTED_LANES],
    maxPlayers: Number.isFinite(maxPlayers) && maxPlayers > 0 ? Math.floor(maxPlayers) : 80,
    matchesPerPlayer:
      Number.isFinite(matchesPerPlayer) && matchesPerPlayer > 0 ? Math.floor(matchesPerPlayer) : 20,
    maxUniqueMatches: Number.isFinite(maxUniqueMatches) && maxUniqueMatches > 0 ? Math.floor(maxUniqueMatches) : 2000,
    resume: !has("no-resume"),
    checkpointPath,
    checkpointEvery: Number.isFinite(checkpointEvery) && checkpointEvery > 0 ? Math.floor(checkpointEvery) : 20
  };
}

async function riotRequest<T>(
  hostType: "platform" | "regional",
  pathValue: string,
  query?: Record<string, string | number>
): Promise<T> {
  const host =
    hostType === "platform"
      ? `https://${env.RIOT_PLATFORM_ROUTE}.api.riotgames.com`
      : `https://${env.RIOT_REGIONAL_ROUTE}.api.riotgames.com`;
  const params = new URLSearchParams();
  if (query) Object.entries(query).forEach(([k, v]) => params.set(k, String(v)));
  const url = `${host}${pathValue}${params.size > 0 ? `?${params.toString()}` : ""}`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await limiter.acquire();
    const response = await fetch(url, { headers: { "X-Riot-Token": env.RIOT_API_KEY ?? "" } });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      const retryMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
      console.log(`429 from Riot. Waiting ${Math.floor(retryMs)}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }
    throw new Error(`Riot API ${response.status}: ${await response.text()}`);
  }

  throw new Error("Riot API kept returning 429 after retries.");
}

function increment(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function serializeBuckets(buckets: Map<string, AggregationBucket>): Record<string, SerializedAggregationBucket> {
  const out: Record<string, SerializedAggregationBucket> = {};
  for (const [key, b] of buckets.entries()) {
    out[key] = {
      games: b.games,
      wins: b.wins,
      totalGoldDiff15: b.totalGoldDiff15,
      pre6Kills: b.pre6Kills,
      pre6Deaths: b.pre6Deaths,
      runes: [...b.runes.entries()],
      items: [...b.items.entries()]
    };
  }
  return out;
}

function deserializeBuckets(raw: Record<string, SerializedAggregationBucket>): Map<string, AggregationBucket> {
  const map = new Map<string, AggregationBucket>();
  for (const [key, b] of Object.entries(raw)) {
    map.set(key, {
      games: b.games,
      wins: b.wins,
      totalGoldDiff15: b.totalGoldDiff15,
      pre6Kills: b.pre6Kills,
      pre6Deaths: b.pre6Deaths,
      runes: new Map<number, number>(b.runes),
      items: new Map<number, number>(b.items)
    });
  }
  return map;
}

async function saveCheckpoint(checkpointPath: string, checkpoint: ScrapeCheckpoint): Promise<void> {
  const absolutePath = path.isAbsolute(checkpointPath) ? checkpointPath : path.resolve(process.cwd(), checkpointPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, JSON.stringify(checkpoint), "utf8");
}

async function loadCheckpoint(checkpointPath: string): Promise<ScrapeCheckpoint | null> {
  const absolutePath = path.isAbsolute(checkpointPath) ? checkpointPath : path.resolve(process.cwd(), checkpointPath);
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    return JSON.parse(content) as ScrapeCheckpoint;
  } catch {
    return null;
  }
}

async function clearCheckpoint(checkpointPath: string): Promise<void> {
  const absolutePath = path.isAbsolute(checkpointPath) ? checkpointPath : path.resolve(process.cwd(), checkpointPath);
  try {
    await fs.unlink(absolutePath);
  } catch {
    // no-op
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  if (!env.RIOT_API_KEY) throw new Error("RIOT_API_KEY is required in .env for scrape script.");

  const options = parseArgs();
  const riotPatchPrefix = toRiotPatchPrefix(options.patch);

  let puuids: string[] = [];
  let nextPlayerIndex = 0;
  let allMatchIds: string[] = [];
  let uniqueMatchIds: string[] = [];
  let nextMatchIndex = 0;
  let matchesProcessed = 0;
  let buckets = new Map<string, AggregationBucket>();
  let phase: "match_ids" | "matches" = "match_ids";

  if (options.resume) {
    const checkpoint = await loadCheckpoint(options.checkpointPath);
    if (
      checkpoint &&
      checkpoint.version === 1 &&
      checkpoint.options.patch === options.patch &&
      checkpoint.options.lanes.join(",") === options.lanes.join(",") &&
      checkpoint.options.maxPlayers === options.maxPlayers &&
      checkpoint.options.matchesPerPlayer === options.matchesPerPlayer &&
      checkpoint.options.maxUniqueMatches === options.maxUniqueMatches
    ) {
      puuids = checkpoint.puuids;
      nextPlayerIndex = checkpoint.nextPlayerIndex;
      allMatchIds = checkpoint.allMatchIds;
      uniqueMatchIds = checkpoint.uniqueMatchIds;
      nextMatchIndex = checkpoint.nextMatchIndex;
      matchesProcessed = checkpoint.matchesProcessed;
      buckets = deserializeBuckets(checkpoint.buckets);
      phase = checkpoint.phase;
      console.log(
        `[scrape] resumed from checkpoint phase=${phase} nextPlayer=${nextPlayerIndex} nextMatch=${nextMatchIndex} pairs=${buckets.size}`
      );
    }
  }

  console.log(
    `[scrape] starting patch=${options.patch} (riotPrefix=${riotPatchPrefix}) maxPlayers=${options.maxPlayers} matchesPerPlayer=${options.matchesPerPlayer} maxUniqueMatches=${options.maxUniqueMatches}`
  );

  if (puuids.length === 0) {
    const leagues = await Promise.all([
      riotRequest<Record<string, unknown>>("platform", "/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5"),
      riotRequest<Record<string, unknown>>("platform", "/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5"),
      riotRequest<Record<string, unknown>>("platform", "/lol/league/v4/masterleagues/by-queue/RANKED_SOLO_5x5")
    ]);
    puuids = [
      ...new Set(
        leagues
          .flatMap((league) => ((league.entries ?? []) as LeagueEntry[]).map((entry) => entry.puuid))
          .filter((puuid): puuid is string => Boolean(puuid))
      )
    ].slice(0, options.maxPlayers);
    console.log(`[scrape] collected players=${puuids.length}`);
  }

  if (phase === "match_ids") {
    for (let i = nextPlayerIndex; i < puuids.length; i += 1) {
      const ids = await riotRequest<string[]>("regional", `/lol/match/v5/matches/by-puuid/${puuids[i]}/ids`, {
        queue: 420,
        count: options.matchesPerPlayer
      });
      allMatchIds.push(...ids);
      nextPlayerIndex = i + 1;

      if ((i + 1) % 10 === 0) console.log(`[scrape] fetched match ids for ${i + 1}/${puuids.length} players`);
      if ((i + 1) % options.checkpointEvery === 0) {
        await saveCheckpoint(options.checkpointPath, {
          version: 1,
          savedAt: new Date().toISOString(),
          options: {
            patch: options.patch,
            lanes: options.lanes,
            maxPlayers: options.maxPlayers,
            matchesPerPlayer: options.matchesPerPlayer,
            maxUniqueMatches: options.maxUniqueMatches
          },
          phase,
          puuids,
          nextPlayerIndex,
          allMatchIds,
          uniqueMatchIds,
          nextMatchIndex,
          matchesProcessed,
          buckets: serializeBuckets(buckets)
        });
      }
    }

    uniqueMatchIds = [...new Set(allMatchIds)].slice(0, options.maxUniqueMatches);
    phase = "matches";
    nextMatchIndex = 0;
    console.log(`[scrape] unique matches queued=${uniqueMatchIds.length}`);
    await saveCheckpoint(options.checkpointPath, {
      version: 1,
      savedAt: new Date().toISOString(),
      options: {
        patch: options.patch,
        lanes: options.lanes,
        maxPlayers: options.maxPlayers,
        matchesPerPlayer: options.matchesPerPlayer,
        maxUniqueMatches: options.maxUniqueMatches
      },
      phase,
      puuids,
      nextPlayerIndex,
      allMatchIds,
      uniqueMatchIds,
      nextMatchIndex,
      matchesProcessed,
      buckets: serializeBuckets(buckets)
    });
  }

  for (let i = nextMatchIndex; i < uniqueMatchIds.length; i += 1) {
    const matchId = uniqueMatchIds[i];
    let match: Record<string, unknown>;
    let timeline: Record<string, unknown>;
    try {
      match = await riotRequest<Record<string, unknown>>("regional", `/lol/match/v5/matches/${matchId}`);
      timeline = await riotRequest<Record<string, unknown>>("regional", `/lol/match/v5/matches/${matchId}/timeline`);
    } catch {
      nextMatchIndex = i + 1;
      continue;
    }

    const info = (match.info ?? {}) as Record<string, unknown>;
    const gameVersion = typeof info.gameVersion === "string" ? info.gameVersion : "";
    if (!gameVersion.startsWith(riotPatchPrefix)) {
      nextMatchIndex = i + 1;
      continue;
    }

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
        if (typeof event.timestamp !== "number" || event.timestamp > 360000) continue;
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
      const bucket =
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
      bucket.games += 1;
      if (player.win === true) bucket.wins += 1;

      const playerGold = pFrames[String(playerId)]?.totalGold;
      const enemyGold = pFrames[String(enemyId)]?.totalGold;
      if (typeof playerGold === "number" && typeof enemyGold === "number") {
        bucket.totalGoldDiff15 += playerGold - enemyGold;
      }

      bucket.pre6Kills += pre6KillsByParticipant.get(playerId) ?? 0;
      bucket.pre6Deaths += pre6KillsByParticipant.get(enemyId) ?? 0;

      const perkStyles = (player.perks as Record<string, unknown> | undefined)?.styles as
        | Array<Record<string, unknown>>
        | undefined;
      const primaryStyleSelections = (perkStyles?.[0]?.selections ?? []) as Array<Record<string, unknown>>;
      const keystoneId = primaryStyleSelections[0]?.perk;
      if (typeof keystoneId === "number") increment(bucket.runes, keystoneId);

      const item0 = player.item0;
      if (typeof item0 === "number" && item0 > 0) increment(bucket.items, item0);

      buckets.set(key, bucket);
    };

    for (const lane of options.lanes) {
      const lanePlayers = participants.filter((p) => p.teamPosition === RIOT_TEAM_POSITION_BY_LANE[lane]);
      if (lanePlayers.length !== 2) continue;

      const left = lanePlayers[0];
      const right = lanePlayers[1];
      const leftChampionName = normalizeChampionName(String(left.championName ?? ""));
      const rightChampionName = normalizeChampionName(String(right.championName ?? ""));
      if (!leftChampionName || !rightChampionName || leftChampionName === rightChampionName) continue;

      applySide(lane, left, right, leftChampionName, rightChampionName);
      applySide(lane, right, left, rightChampionName, leftChampionName);
    }
    matchesProcessed += 1;
    nextMatchIndex = i + 1;

    if ((i + 1) % 25 === 0) {
      console.log(
        `[scrape] processed ${i + 1}/${uniqueMatchIds.length} matches | accepted=${matchesProcessed} | pairs=${buckets.size}`
      );
    }

    if ((i + 1) % options.checkpointEvery === 0) {
      await saveCheckpoint(options.checkpointPath, {
        version: 1,
        savedAt: new Date().toISOString(),
        options: {
          patch: options.patch,
          lanes: options.lanes,
          maxPlayers: options.maxPlayers,
          matchesPerPlayer: options.matchesPerPlayer,
          maxUniqueMatches: options.maxUniqueMatches
        },
        phase,
        puuids,
        nextPlayerIndex,
        allMatchIds,
        uniqueMatchIds,
        nextMatchIndex,
        matchesProcessed,
        buckets: serializeBuckets(buckets)
      });
    }
  }

  let repository: MatchupStatsStore;
  if (env.DB_PROVIDER === "postgres") {
    if (!env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required when DB_PROVIDER=postgres.");
    }
    const pool = await getPostgresPool(env.DATABASE_URL);
    repository = new PostgresMatchupStatsRepository(pool);
  } else {
    const db = await getDatabase(env.STATS_DB_PATH);
    repository = new MatchupStatsRepository(db);
  }
  const expiresAt = Date.now() + env.STATS_CACHE_TTL_MINUTES * 60 * 1000;
  const rows = [...buckets.entries()].map(([key, bucket]) => {
    const [, lane, playerChampion, enemyChampion] = key.split(":");
    const games = bucket.games;
    return {
      patch: options.patch,
      lane: lane as SupportedLane,
      playerChampion,
      enemyChampion,
      stats: {
        patch: options.patch,
        games,
        winRate: Number((bucket.wins / games).toFixed(3)),
        goldDiff15: Math.round(bucket.totalGoldDiff15 / games),
        pre6KillRate: Number((bucket.pre6Kills / games).toFixed(3)),
        earlyDeathRate: Number((bucket.pre6Deaths / games).toFixed(3)),
        runeUsage: [...bucket.runes.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([keystoneId, count]) => ({ keystoneId, count, pct: Number((count / games).toFixed(3)) })),
        firstItemUsage: [...bucket.items.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([itemId, count]) => ({ itemId, count, pct: Number((count / games).toFixed(3)) })),
        computedAt: new Date().toISOString()
      },
      expiresAtMs: expiresAt
    };
  });

  await repository.upsertMany(rows);
  await clearCheckpoint(options.checkpointPath);

  const byLaneWritten = options.lanes.reduce<Record<string, number>>((acc, lane) => {
    acc[lane] = rows.filter((row) => row.lane === lane).length;
    return acc;
  }, {});

  const byLaneCached = await Promise.all(
    options.lanes.map(async (lane) => {
      const overview = await repository.getCacheOverview(options.patch, lane);
      return {
        lane,
        cachedPairs: overview.totalCount,
        freshPairs: overview.freshCount,
        latestComputedAt: overview.latestComputedAt
      };
    })
  );

  const elapsedMs = Date.now() - startedAt;
  console.log("");
  console.log("[scrape] SUCCESS");
  console.log(`[scrape] duration=${formatDuration(elapsedMs)} patch=${options.patch}`);
  console.log(
    `[scrape] lanes=${options.lanes.join(",")} players=${puuids.length} uniqueMatches=${uniqueMatchIds.length} acceptedMatches=${matchesProcessed} pairsWritten=${rows.length}`
  );
  console.log(`[scrape] pairsWrittenByLane=${JSON.stringify(byLaneWritten)}`);
  console.log(`[scrape] cacheOverviewByLane=${JSON.stringify(byLaneCached)}`);
  console.log("[scrape] import complete.");
}

main().catch((error) => {
  console.error("[scrape] FAILED");
  console.error("[scrape] failed:", error);
  process.exit(1);
});
