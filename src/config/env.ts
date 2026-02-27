import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  CURRENT_PATCH: z.string().regex(/^[0-9]{2}\.[0-9]{1,2}$/).default("26.4"),
  EXTERNAL_STATS_PROVIDER: z.enum(["none", "lolalytics"]).default("none"),
  EXTERNAL_STATS_TIMEOUT_MS: z.coerce.number().int().positive().default(3500),
  GEMINI_API_KEY: z.string().min(10).optional(),
  GEMINI_API_KEYS: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  DB_PROVIDER: z.enum(["sqlite", "postgres"]).default("sqlite"),
  DATABASE_URL: z.string().url().optional(),
  STATS_DB_PATH: z.string().min(1).default("./data/matchup-coach.db"),
  STATS_CACHE_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  MATCHUP_MIN_SAMPLE_GAMES: z.coerce.number().int().positive().default(10)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Environment variable validation failed.");
}

export const env = parsed.data;
