import { z } from "zod";
import { SUPPORTED_COACH_LANES } from "../data/champions.js";

export const coachMatchupRequestSchema = z
  .object({
    playerChampion: z.string().min(2).max(40),
    enemyChampion: z.string().min(2).max(40),
    playerChampionPartner: z.string().min(2).max(40).optional(),
    enemyChampionPartner: z.string().min(2).max(40).optional(),
    playerRole: z.enum(["adc", "support"]).optional(),
    lane: z.enum(SUPPORTED_COACH_LANES).optional(),
    patch: z
      .string()
      .regex(/^[0-9]{2}\.[0-9]{1,2}$/)
      .optional(),
    language: z.literal("en").optional()
  })
  .strict()
  .refine((data) => data.playerChampion !== data.enemyChampion, {
    message: "playerChampion and enemyChampion must be different.",
    path: ["enemyChampion"]
  })
  .refine((data) => {
    if (data.lane !== "bot") return true;
    const hasAllyPartner = Boolean(data.playerChampionPartner && data.playerChampionPartner.trim());
    const hasEnemyPartner = Boolean(data.enemyChampionPartner && data.enemyChampionPartner.trim());
    return hasAllyPartner && hasEnemyPartner;
  }, {
    message: "Bot lane requires both allied and enemy partner champions.",
    path: ["playerChampionPartner"]
  })
  .refine((data) => {
    if (data.lane !== "bot") return true;
    return Boolean(data.playerRole);
  }, {
    message: "Bot lane requires playerRole (adc or support).",
    path: ["playerRole"]
  })
  .refine((data) => {
    if (data.lane !== "bot") return true;
    return (
      data.playerChampion !== data.playerChampionPartner && data.enemyChampion !== data.enemyChampionPartner
    );
  }, {
    message: "Bot lane primary and partner champions must be different per side.",
    path: ["playerChampionPartner"]
  });

const allInWindowSchema = z.object({
  timing: z.enum(["level_2", "level_3", "level_6", "first_item", "enemy_misstep"]),
  signal: z.string().min(4).max(160),
  action: z.string().min(4).max(220)
});

const botEnemyAdviceSchema = z.object({
  threatPattern: z.string().min(10).max(240),
  spacingRule: z.string().min(10).max(220),
  punishWindow: z.string().min(10).max(220),
  commonTrap: z.string().min(10).max(220)
});

export const coachMatchupResponseSchema = z
  .object({
    matchup: z.object({
      playerChampion: z.string(),
      enemyChampion: z.string(),
      playerChampionPartner: z.string().optional(),
      enemyChampionPartner: z.string().optional(),
      playerRole: z.enum(["adc", "support"]).optional(),
      lane: z.enum(SUPPORTED_COACH_LANES),
      patch: z.string()
    }),
    difficulty: z.enum(["easy", "favored", "even", "not_favored", "hard"]),
    earlyGamePlan: z.string().min(20).max(600),
    level1to3Rules: z.array(z.string().min(8).max(160)).min(3).max(5),
    allInWindows: z.array(allInWindowSchema).min(2).max(5),
    runeAdjustments: z.object({
      keystone: z.object({
        recommended: z.string().max(40),
        reason: z.string().max(180)
      }),
      secondary: z.object({
        tree: z.string().max(40),
        reason: z.string().max(180)
      }),
      shardsNote: z.string().max(140)
    }),
    commonMistakes: z.tuple([
      z.string().min(10).max(180),
      z.string().min(10).max(180),
      z.string().min(10).max(180)
    ]),
    botlaneAdvice: z
      .object({
        playerRole: z.enum(["adc", "support"]),
        vsEnemyAdc: botEnemyAdviceSchema,
        vsEnemySupport: botEnemyAdviceSchema
      })
      .optional(),
    meta: z.object({
      generatedAt: z.iso.datetime(),
      dataConfidence: z.enum(["low", "medium", "high"]),
      sampleSize: z.number().int().nonnegative(),
      winRate: z.number().min(0).max(1).nullable(),
      sampleTarget: z.number().int().positive(),
      providerSamples: z.object({
        riotGames: z.number().int().nonnegative(),
        externalGames: z.number().int().nonnegative(),
        effectiveGames: z.number().int().nonnegative()
      }),
      externalSource: z
        .object({
          provider: z.string(),
          status: z.enum(["success", "cache_hit", "http_error", "timeout", "network_error", "parse_miss"]),
          failureReason: z.string().optional(),
          httpStatus: z.number().int().optional()
        })
        .nullable(),
      source: z.object({
        stats: z.boolean(),
        tags: z.boolean(),
        rag: z.boolean(),
        cacheHit: z.boolean()
      }),
      warnings: z.array(z.string().max(120)).default([])
    })
  })
  .strict();

export type CoachMatchupRequestInput = z.infer<typeof coachMatchupRequestSchema>;
export type CoachMatchupResponseOutput = z.infer<typeof coachMatchupResponseSchema>;
