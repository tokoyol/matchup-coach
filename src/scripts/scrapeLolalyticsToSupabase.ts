import { env } from "../config/env.js";
import { SUPPORTED_TOP_CHAMPIONS, normalizeChampionName, normalizeLane, type SupportedLane } from "../data/champions.js";
import { getPostgresPool } from "../db/postgres.js";
import { LolalyticsScrapeProvider } from "../services/externalMatchupStatsProvider.js";
import { PostgresMatchupStatsRepository } from "../services/postgresMatchupStatsRepository.js";
import type { MatchupStats } from "../types/stats.js";

interface CliOptions {
  patch: string;
  lane: SupportedLane;
  champions: string[];
  maxPairs: number;
  startIndex: number;
  requestDelayMs: number;
}

interface Pair {
  playerChampion: string;
  enemyChampion: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const read = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
    return fallback;
  };

  const patch = read("patch", env.CURRENT_PATCH);
  const lane = normalizeLane(read("lane", "top"));
  const championsRaw = read("champions", SUPPORTED_TOP_CHAMPIONS.join(","));
  const champions = championsRaw
    .split(",")
    .map((value) => normalizeChampionName(value))
    .filter((name, idx, arr) => Boolean(name) && arr.indexOf(name) === idx);
  const maxPairs = Number(read("maxPairs", "0"));
  const startIndex = Number(read("startIndex", "0"));
  const requestDelayMs = Number(read("requestDelayMs", "80"));

  return {
    patch,
    lane,
    champions: champions.length > 1 ? champions : [...SUPPORTED_TOP_CHAMPIONS],
    maxPairs: Number.isFinite(maxPairs) && maxPairs > 0 ? Math.floor(maxPairs) : 0,
    startIndex: Number.isFinite(startIndex) && startIndex >= 0 ? Math.floor(startIndex) : 0,
    requestDelayMs: Number.isFinite(requestDelayMs) && requestDelayMs >= 0 ? Math.floor(requestDelayMs) : 80
  };
}

function buildPairs(champions: string[]): Pair[] {
  const pairs: Pair[] = [];
  for (const playerChampion of champions) {
    for (const enemyChampion of champions) {
      if (playerChampion === enemyChampion) continue;
      pairs.push({ playerChampion, enemyChampion });
    }
  }
  return pairs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to upload into Supabase/Postgres.");
  }

  const options = parseArgs();
  const provider = new LolalyticsScrapeProvider(env.EXTERNAL_STATS_TIMEOUT_MS);
  const pool = await getPostgresPool(env.DATABASE_URL);
  const repository = new PostgresMatchupStatsRepository(pool);
  const expiresAt = Date.now() + env.STATS_CACHE_TTL_MINUTES * 60 * 1000;

  const allPairs = buildPairs(options.champions);
  const start = Math.min(options.startIndex, Math.max(0, allPairs.length - 1));
  const selectedPairs = options.maxPairs > 0 ? allPairs.slice(start, start + options.maxPairs) : allPairs.slice(start);

  console.log(
    `[lolalytics] start patch=${options.patch} lane=${options.lane} champions=${options.champions.length} pairs=${selectedPairs.length} startIndex=${start}`
  );

  const rows: Array<{
    patch: string;
    lane: SupportedLane;
    playerChampion: string;
    enemyChampion: string;
    stats: MatchupStats;
    expiresAtMs: number;
  }> = [];
  const statusCounts = new Map<string, number>();
  let written = 0;

  for (let i = 0; i < selectedPairs.length; i += 1) {
    const pair = selectedPairs[i];
    const outcome = await provider.getMatchupStats({
      patch: options.patch,
      lane: options.lane,
      playerChampion: pair.playerChampion,
      enemyChampion: pair.enemyChampion
    });
    statusCounts.set(outcome.status, (statusCounts.get(outcome.status) ?? 0) + 1);

    if (outcome.result?.stats) {
      rows.push({
        patch: options.patch,
        lane: options.lane,
        playerChampion: pair.playerChampion,
        enemyChampion: pair.enemyChampion,
        stats: outcome.result.stats,
        expiresAtMs: expiresAt
      });
    }

    if ((i + 1) % 25 === 0 || i + 1 === selectedPairs.length) {
      console.log(
        `[lolalytics] progress ${i + 1}/${selectedPairs.length} | successRows=${rows.length} | statuses=${JSON.stringify(Object.fromEntries(statusCounts))}`
      );
    }
    if (options.requestDelayMs > 0) {
      await sleep(options.requestDelayMs);
    }
  }

  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await repository.upsertMany(chunk);
    written += chunk.length;
    console.log(`[lolalytics] upserted ${written}/${rows.length} rows`);
  }

  const overview = await repository.getCacheOverview(options.patch, options.lane);
  console.log("[lolalytics] SUCCESS");
  console.log(`[lolalytics] wrote=${written} rows`);
  console.log(`[lolalytics] statusCounts=${JSON.stringify(Object.fromEntries(statusCounts))}`);
  console.log(
    `[lolalytics] cacheOverview lane=${options.lane} patch=${options.patch} cachedPairs=${overview.totalCount} latest=${overview.latestComputedAt ?? "-"}`
  );
}

main().catch((error) => {
  console.error("[lolalytics] FAILED");
  console.error(error);
  process.exit(1);
});
