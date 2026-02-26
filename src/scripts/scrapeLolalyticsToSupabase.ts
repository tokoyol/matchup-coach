import { env } from "../config/env.js";
import {
  SUPPORTED_LANES,
  SUPPORTED_TOP_CHAMPIONS,
  normalizeChampionName,
  normalizeLane,
  type SupportedLane
} from "../data/champions.js";
import { getPostgresPool } from "../db/postgres.js";
import { LolalyticsScrapeProvider } from "../services/externalMatchupStatsProvider.js";
import { PostgresMatchupStatsRepository } from "../services/postgresMatchupStatsRepository.js";
import type { MatchupStats } from "../types/stats.js";

interface CliOptions {
  patch: string;
  lanes: SupportedLane[];
  champions: string[];
  championsArgProvided: boolean;
  allChampions: boolean;
  maxChampions: number;
  skipExisting: boolean;
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
  const has = (name: string): boolean => args.includes(`--${name}`);

  const patch = read("patch", env.CURRENT_PATCH);
  const lanesRaw = read("lanes", read("lane", "top"));
  const lanes = lanesRaw
    .split(",")
    .map((value) => normalizeLane(value))
    .filter((lane, idx, arr) => arr.indexOf(lane) === idx);
  const championsArgProvided = has("champions");
  const championsRaw = read("champions", SUPPORTED_TOP_CHAMPIONS.join(","));
  const champions = championsRaw
    .split(",")
    .map((value) => normalizeChampionName(value))
    .filter((name, idx, arr) => Boolean(name) && arr.indexOf(name) === idx);
  const allChampions = has("allChampions");
  const skipExisting = !has("noSkipExisting");
  const maxChampions = Number(read("maxChampions", "0"));
  const maxPairs = Number(read("maxPairs", "0"));
  const startIndex = Number(read("startIndex", "0"));
  const requestDelayMs = Number(read("requestDelayMs", "80"));

  return {
    patch,
    lanes: lanes.length > 0 ? lanes : [...SUPPORTED_LANES],
    champions: champions.length > 1 ? champions : [...SUPPORTED_TOP_CHAMPIONS],
    championsArgProvided,
    allChampions,
    maxChampions: Number.isFinite(maxChampions) && maxChampions > 0 ? Math.floor(maxChampions) : 0,
    skipExisting,
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

async function loadChampionsFromDataDragon(maxChampions: number): Promise<string[]> {
  const versionsRes = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  if (!versionsRes.ok) {
    throw new Error(`Failed to fetch Data Dragon versions: HTTP ${versionsRes.status}`);
  }
  const versions = (await versionsRes.json()) as string[];
  const latest = versions[0];
  if (!latest) {
    throw new Error("Data Dragon returned no versions.");
  }
  const champsRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`);
  if (!champsRes.ok) {
    throw new Error(`Failed to fetch Data Dragon champions: HTTP ${champsRes.status}`);
  }
  const payload = (await champsRes.json()) as {
    data: Record<string, { name: string }>;
  };
  const champions = Object.values(payload.data)
    .map((entry) => normalizeChampionName(entry.name))
    .filter((name, idx, arr) => Boolean(name) && arr.indexOf(name) === idx)
    .sort((a, b) => a.localeCompare(b));
  if (maxChampions > 0) return champions.slice(0, maxChampions);
  return champions;
}

async function loadExistingPairKeys(params: {
  pool: Awaited<ReturnType<typeof getPostgresPool>>;
  patch: string;
  lane: SupportedLane;
}): Promise<Set<string>> {
  const result = await params.pool.query<{
    player_champion: string;
    enemy_champion: string;
  }>(
    `
      SELECT player_champion, enemy_champion
      FROM matchup_stats_cache
      WHERE patch = $1 AND lane = $2
    `,
    [params.patch, params.lane]
  );
  const keys = new Set<string>();
  for (const row of result.rows) {
    keys.add(`${row.player_champion}:::${row.enemy_champion}`);
  }
  return keys;
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

  const champions =
    options.allChampions && !options.championsArgProvided
      ? await loadChampionsFromDataDragon(options.maxChampions)
      : options.maxChampions > 0
        ? options.champions.slice(0, options.maxChampions)
        : options.champions;

  const rows: Array<{
    patch: string;
    lane: SupportedLane;
    playerChampion: string;
    enemyChampion: string;
    stats: MatchupStats;
    expiresAtMs: number;
  }> = [];
  let totalWritten = 0;
  const globalStatusCounts = new Map<string, number>();

  for (const lane of options.lanes) {
    rows.length = 0;
    const statusCounts = new Map<string, number>();
    let written = 0;

    const allPairs = buildPairs(champions);
    const existingKeys = options.skipExisting
      ? await loadExistingPairKeys({ pool, patch: options.patch, lane })
      : new Set<string>();
    const missingPairs = options.skipExisting
      ? allPairs.filter((pair) => !existingKeys.has(`${pair.playerChampion}:::${pair.enemyChampion}`))
      : allPairs;
    const start = options.startIndex;
    const selectedPairs =
      missingPairs.length === 0 || start >= missingPairs.length
        ? []
        : options.maxPairs > 0
          ? missingPairs.slice(start, start + options.maxPairs)
          : missingPairs.slice(start);

    console.log(
      `[lolalytics] start patch=${options.patch} lane=${lane} champions=${champions.length} totalPairs=${allPairs.length} missingPairs=${missingPairs.length} selectedPairs=${selectedPairs.length} startIndex=${start} skipExisting=${options.skipExisting}`
    );

    for (let i = 0; i < selectedPairs.length; i += 1) {
      const pair = selectedPairs[i];
      const outcome = await provider.getMatchupStats({
        patch: options.patch,
        lane,
        playerChampion: pair.playerChampion,
        enemyChampion: pair.enemyChampion
      });
      statusCounts.set(outcome.status, (statusCounts.get(outcome.status) ?? 0) + 1);
      globalStatusCounts.set(outcome.status, (globalStatusCounts.get(outcome.status) ?? 0) + 1);

      if (outcome.result?.stats) {
        rows.push({
          patch: options.patch,
          lane,
          playerChampion: pair.playerChampion,
          enemyChampion: pair.enemyChampion,
          stats: outcome.result.stats,
          expiresAtMs: expiresAt
        });
      }

      if ((i + 1) % 25 === 0 || i + 1 === selectedPairs.length) {
        console.log(
          `[lolalytics] progress lane=${lane} ${i + 1}/${selectedPairs.length} | successRows=${rows.length} | statuses=${JSON.stringify(Object.fromEntries(statusCounts))}`
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
      totalWritten += chunk.length;
      console.log(`[lolalytics] upserted lane=${lane} ${written}/${rows.length} rows`);
    }

    const overview = await repository.getCacheOverview(options.patch, lane);
    console.log(`[lolalytics] lane=${lane} wrote=${written} rows`);
    console.log(`[lolalytics] lane=${lane} statusCounts=${JSON.stringify(Object.fromEntries(statusCounts))}`);
    console.log(
      `[lolalytics] lane=${lane} cacheOverview patch=${options.patch} cachedPairs=${overview.totalCount} latest=${overview.latestComputedAt ?? "-"}`
    );
  }
  console.log("[lolalytics] SUCCESS");
  console.log(`[lolalytics] lanes=${options.lanes.join(",")} totalWritten=${totalWritten}`);
  console.log(`[lolalytics] globalStatusCounts=${JSON.stringify(Object.fromEntries(globalStatusCounts))}`);
}

main().catch((error) => {
  console.error("[lolalytics] FAILED");
  console.error(error);
  process.exit(1);
});
