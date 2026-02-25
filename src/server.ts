import cors from "cors";
import express from "express";
import { createMatchupRouter } from "./routes/matchup.js";
import { env } from "./config/env.js";
import { getPostgresPool } from "./db/postgres.js";
import { getDatabase } from "./db/sqlite.js";
import { LolalyticsScrapeProvider, type ExternalMatchupStatsProvider } from "./services/externalMatchupStatsProvider.js";
import { GeminiCoachService } from "./services/geminiCoachService.js";
import { MatchupStatsRepository } from "./services/matchupStatsRepository.js";
import { MissingPairBackfillService } from "./services/missingPairBackfillService.js";
import { PostgresMatchupStatsRepository } from "./services/postgresMatchupStatsRepository.js";
import { startNightlyPrecompute } from "./services/nightlyPrecomputeScheduler.js";
import { RiotApiClient } from "./services/riotApiClient.js";
import { RiotMatchupStatsService } from "./services/riotMatchupStatsService.js";
import { RiotPrecomputeService } from "./services/riotPrecomputeService.js";
import type { MatchupStatsStore } from "./services/matchupStatsStore.js";

async function bootstrap(): Promise<void> {
  const app = express();
  app.use(
    cors({
      origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN
    })
  );
  app.use(express.json());

  let riotStatsService: RiotMatchupStatsService | undefined;
  let riotApiClient: RiotApiClient | undefined;
  let riotPrecomputeService: RiotPrecomputeService | undefined;
  let missingPairBackfillService: MissingPairBackfillService | undefined;
  let externalStatsProvider: ExternalMatchupStatsProvider | undefined;
  let statsRepository: MatchupStatsStore | undefined;
  const geminiKeys = [
    ...new Set(
      [
        ...(env.GEMINI_API_KEYS
          ? env.GEMINI_API_KEYS.split(",")
              .map((value) => value.trim())
              .filter((value) => value.length > 0)
          : []),
        ...(env.GEMINI_API_KEY ? [env.GEMINI_API_KEY] : [])
      ].filter((value) => value.length > 0)
    )
  ];
  const geminiCoachService = geminiKeys.length > 0
    ? new GeminiCoachService({
        apiKeys: geminiKeys,
        model: env.GEMINI_MODEL
      })
    : undefined;
  if (env.RIOT_API_KEY && env.RIOT_ENABLE_LIVE_STATS) {
    if (env.DB_PROVIDER === "postgres") {
      if (!env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when DB_PROVIDER=postgres.");
      }
      const pgPool = await getPostgresPool(env.DATABASE_URL);
      statsRepository = new PostgresMatchupStatsRepository(pgPool);
      console.log("[db] Using postgres provider for matchup cache.");
    } else {
      const db = await getDatabase(env.STATS_DB_PATH);
      statsRepository = new MatchupStatsRepository(db);
      console.log(`[db] Using sqlite provider at ${env.STATS_DB_PATH}.`);
    }

    const riotClient = new RiotApiClient({
      apiKey: env.RIOT_API_KEY,
      platformRoute: env.RIOT_PLATFORM_ROUTE,
      regionalRoute: env.RIOT_REGIONAL_ROUTE,
      minIntervalMs: env.RIOT_REQUEST_MIN_INTERVAL_MS,
      maxRetries: env.RIOT_MAX_RETRIES,
      retryBaseMs: env.RIOT_RETRY_BASE_MS,
      rateLimitCooldownMs: env.RIOT_RATE_LIMIT_COOLDOWN_SECONDS * 1000
    });
    riotApiClient = riotClient;

    riotStatsService = new RiotMatchupStatsService(riotClient, {
      cacheTtlMs: env.STATS_CACHE_TTL_MINUTES * 60 * 1000,
      repository: statsRepository
    });
    missingPairBackfillService = new MissingPairBackfillService(riotStatsService, {
      enabled: env.BACKFILL_ON_MISS_ENABLED,
      maxQueueSize: env.BACKFILL_MAX_QUEUE_SIZE,
      cooldownMs: env.BACKFILL_COOLDOWN_MINUTES * 60 * 1000,
      maxTrackedPlayers: env.BACKFILL_MAX_TRACKED_PLAYERS,
      maxMatchesPerPlayer: env.BACKFILL_MATCHES_PER_PLAYER,
      maxUniqueMatchIds: env.BACKFILL_MAX_UNIQUE_MATCHES
    });
    riotPrecomputeService = new RiotPrecomputeService(
      riotClient,
      statsRepository,
      env.STATS_CACHE_TTL_MINUTES * 60 * 1000
    );

    if (env.PRECOMPUTE_NIGHTLY_ENABLED) {
      startNightlyPrecompute(riotPrecomputeService, {
        patch: env.CURRENT_PATCH,
        hourUtc: env.PRECOMPUTE_HOUR_UTC,
        maxTrackedPlayers: env.PRECOMPUTE_MAX_TRACKED_PLAYERS,
        matchesPerPlayer: env.PRECOMPUTE_MATCHES_PER_PLAYER,
        maxUniqueMatches: env.PRECOMPUTE_MAX_UNIQUE_MATCHES,
        concurrency: env.PRECOMPUTE_CONCURRENCY
      });
      console.log(
        `[nightly-precompute] enabled at ${env.PRECOMPUTE_HOUR_UTC}:00 UTC for patch ${env.CURRENT_PATCH}`
      );
    }
  }
  if (env.EXTERNAL_STATS_PROVIDER === "lolalytics") {
    externalStatsProvider = new LolalyticsScrapeProvider(env.EXTERNAL_STATS_TIMEOUT_MS);
    console.log("[stats] External matchup provider enabled: lolalytics.");
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "matchup-coach-backend",
      patch: env.CURRENT_PATCH,
      liveStatsEnabled: Boolean(riotStatsService)
    });
  });

  app.use(
    "/api",
    createMatchupRouter({
      currentPatch: env.CURRENT_PATCH,
      enableLiveStats: Boolean(riotStatsService),
      minSampleGames: env.MATCHUP_MIN_SAMPLE_GAMES,
      statsRepository,
      riotStatsService,
      riotApiClient,
      riotPrecomputeService,
      missingPairBackfillService,
      externalStatsProvider,
      geminiCoachService,
      adminApiToken: env.ADMIN_API_TOKEN
    })
  );

  app.listen(env.PORT, () => {
    console.log(`matchup-coach-backend listening on http://localhost:${env.PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start matchup coach backend:", error);
  process.exit(1);
});
