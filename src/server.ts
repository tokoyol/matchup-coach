import cors from "cors";
import express from "express";
import { createMatchupRouter } from "./routes/matchup.js";
import { env } from "./config/env.js";
import { getPostgresPool } from "./db/postgres.js";
import { getDatabase } from "./db/sqlite.js";
import { LolalyticsScrapeProvider, type ExternalMatchupStatsProvider } from "./services/externalMatchupStatsProvider.js";
import { GeminiCoachService } from "./services/geminiCoachService.js";
import { MatchupStatsRepository } from "./services/matchupStatsRepository.js";
import { PostgresMatchupStatsRepository } from "./services/postgresMatchupStatsRepository.js";
import type { MatchupStatsStore } from "./services/matchupStatsStore.js";

async function bootstrap(): Promise<void> {
  const app = express();
  app.use(
    cors({
      origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN
    })
  );
  app.use(express.json());

  let externalStatsProvider: ExternalMatchupStatsProvider | undefined;
  let statsRepository: MatchupStatsStore | undefined;
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
  // Matchup responses are served from cached DB + external provider data.
  if (env.EXTERNAL_STATS_PROVIDER === "lolalytics") {
    externalStatsProvider = new LolalyticsScrapeProvider(env.EXTERNAL_STATS_TIMEOUT_MS);
    console.log("[stats] External matchup provider enabled: lolalytics.");
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "matchup-coach-backend",
      patch: env.CURRENT_PATCH,
      liveStatsEnabled: false
    });
  });

  app.use(
    "/api",
    createMatchupRouter({
      currentPatch: env.CURRENT_PATCH,
      minSampleGames: env.MATCHUP_MIN_SAMPLE_GAMES,
      statsRepository,
      externalStatsProvider,
      geminiCoachService
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
