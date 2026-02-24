import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  CURRENT_PATCH: z.string().regex(/^[0-9]{2}\.[0-9]{1,2}$/).default("14.3"),
  RIOT_API_KEY: z.string().min(10).optional(),
  RIOT_PLATFORM_ROUTE: z
    .enum(["br1", "eun1", "euw1", "jp1", "kr", "la1", "la2", "na1", "oc1", "tr1", "ru"])
    .default("na1"),
  RIOT_REGIONAL_ROUTE: z.enum(["americas", "asia", "europe", "sea"]).default("americas"),
  RIOT_REQUEST_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(150),
  RIOT_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  RIOT_RETRY_BASE_MS: z.coerce.number().int().positive().default(800),
  RIOT_RATE_LIMIT_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(45),
  RIOT_ENABLE_LIVE_STATS: z.enum(["true", "false"]).optional().default("false").transform((v) => v === "true"),
  EXTERNAL_STATS_PROVIDER: z.enum(["none", "lolalytics"]).default("none"),
  EXTERNAL_STATS_TIMEOUT_MS: z.coerce.number().int().positive().default(3500),
  GEMINI_API_KEY: z.string().min(10).optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  DB_PROVIDER: z.enum(["sqlite", "postgres"]).default("sqlite"),
  DATABASE_URL: z.string().url().optional(),
  STATS_DB_PATH: z.string().min(1).default("./data/matchup-coach.db"),
  STATS_CACHE_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  PRECOMPUTE_NIGHTLY_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  PRECOMPUTE_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),
  PRECOMPUTE_MAX_TRACKED_PLAYERS: z.coerce.number().int().positive().default(30),
  PRECOMPUTE_MATCHES_PER_PLAYER: z.coerce.number().int().positive().default(8),
  PRECOMPUTE_MAX_UNIQUE_MATCHES: z.coerce.number().int().positive().default(300),
  PRECOMPUTE_CONCURRENCY: z.coerce.number().int().positive().default(3),
  BACKFILL_ON_MISS_ENABLED: z.enum(["true", "false"]).optional().default("true").transform((v) => v === "true"),
  BACKFILL_MAX_QUEUE_SIZE: z.coerce.number().int().positive().default(100),
  BACKFILL_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(20),
  BACKFILL_MAX_TRACKED_PLAYERS: z.coerce.number().int().positive().default(18),
  BACKFILL_MATCHES_PER_PLAYER: z.coerce.number().int().positive().default(6),
  BACKFILL_MAX_UNIQUE_MATCHES: z.coerce.number().int().positive().default(700),
  MATCHUP_MIN_SAMPLE_GAMES: z.coerce.number().int().positive().default(10),
  ADMIN_API_TOKEN: z.string().min(12).optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Environment variable validation failed.");
}

export const env = parsed.data;
