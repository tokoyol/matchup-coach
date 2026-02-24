import type { CoachMatchupRequestInput, CoachMatchupResponseOutput } from "../schemas/matchup.js";
import { CHAMPION_TAGS } from "../data/champions.js";
import type { MatchupStats } from "../types/stats.js";
import { GeminiCoachService } from "./geminiCoachService.js";

const KEYSTONE_NAMES: Record<number, string> = {
  8005: "Press the Attack",
  8008: "Lethal Tempo",
  8010: "Conqueror",
  8021: "Fleet Footwork",
  8112: "Electrocute",
  8128: "Dark Harvest",
  9923: "Hail of Blades",
  8214: "Summon Aery",
  8229: "Arcane Comet",
  8230: "Phase Rush",
  8351: "Glacial Augment",
  8360: "Unsealed Spellbook",
  8369: "First Strike",
  8437: "Grasp of the Undying",
  8439: "Aftershock",
  8465: "Guardian"
};

function fallbackRuneAdjustments(stats?: MatchupStats | null): CoachMatchupResponseOutput["runeAdjustments"] {
  const topRune = stats?.runeUsage?.[0];
  if (!stats || !topRune || stats.games <= 0) {
    return {
      keystone: { recommended: "", reason: "" },
      secondary: { tree: "", reason: "" },
      shardsNote: ""
    };
  }

  const keystoneName = KEYSTONE_NAMES[topRune.keystoneId] ?? `Keystone ${topRune.keystoneId}`;
  const pct = `${Math.round(topRune.pct * 100)}%`;
  return {
    keystone: {
      recommended: keystoneName,
      reason: `Most common in this matchup sample (${pct} pick rate).`
    },
    secondary: { tree: "", reason: "" },
    shardsNote: ""
  };
}

function estimateDifficulty(
  playerChampion: string,
  enemyChampion: string,
  stats?: MatchupStats | null
): "easy" | "favored" | "even" | "not_favored" | "hard" {
  const mapScoreToDifficulty = (
    score: number
  ): "easy" | "favored" | "even" | "not_favored" | "hard" => {
    if (score >= 3) return "easy";
    if (score >= 1) return "favored";
    if (score <= -3) return "hard";
    if (score <= -1) return "not_favored";
    return "even";
  };

  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
  const likelyMissingLaneMetrics = (input: MatchupStats): boolean => {
    // External scraped sources can provide strong sample+winrate but miss lane-specific metrics.
    // If those metrics are missing, rely on winrate thresholds directly.
    return (
      input.games >= 200 &&
      input.goldDiff15 === 0 &&
      input.pre6KillRate === 0 &&
      input.earlyDeathRate === 0
    );
  };

  if (stats && stats.games >= 8) {
    if (likelyMissingLaneMetrics(stats)) {
      if (stats.winRate >= 0.54) return "easy";
      if (stats.winRate >= 0.515) return "favored";
      if (stats.winRate <= 0.445) return "hard";
      if (stats.winRate <= 0.485) return "not_favored";
      return "even";
    }
    const goldComponent = clamp(stats.goldDiff15 / 250, -2, 2);
    const winRateComponent = clamp((stats.winRate - 0.5) / 0.04, -2, 2);
    const pre6SkirmishComponent = clamp((stats.pre6KillRate - stats.earlyDeathRate) / 0.08, -2, 2);
    const score = goldComponent + winRateComponent + pre6SkirmishComponent;
    return mapScoreToDifficulty(score);
  }

  const playerTags = CHAMPION_TAGS[playerChampion] ?? [];
  const enemyTags = CHAMPION_TAGS[enemyChampion] ?? [];

  let score = 0;
  if (playerTags.includes("lane_bully")) score += 1;
  if (playerTags.includes("ranged")) score += 1;
  if (enemyTags.includes("lane_bully")) score -= 1;
  if (enemyTags.includes("ranged") && !playerTags.includes("ranged")) score -= 1;
  if (playerTags.includes("weak_early")) score -= 1;
  if (enemyTags.includes("weak_early")) score += 1;

  return mapScoreToDifficulty(score);
}

function applyMatchupPriors(
  input: CoachMatchupRequestInput,
  advice: Pick<
    CoachMatchupResponseOutput,
    "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
  >
): Pick<
  CoachMatchupResponseOutput,
  "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
> {
  if (input.lane === "top" && input.playerChampion === "Aatrox" && input.enemyChampion === "Darius") {
    const rules = [
      "Level 1: Start Q and keep spacing so Darius cannot freely stack passive.",
      "Level 2: Take E for repositioning, dodge angle, and safer Q spacing.",
      "Level 3: Take W to threaten pull-back trades after landing Q sweet spots."
    ];
    return {
      ...advice,
      level1to3Rules: rules
    };
  }
  if (input.lane === "top" && input.playerChampion === "Aatrox" && input.enemyChampion === "Vayne") {
    const rules = [
      "Level 1: Start Q and last-hit patiently; do not overextend into free ranged autos.",
      "Level 2: Take E for spacing and repositioning control.",
      "Level 3: Take W to punish oversteps and chain short trades after Q hits; avoid fighting near walls."
    ];
    const windows = [
      {
        timing: "level_3" as const,
        signal: "Vayne uses Q aggressively into your wave and is outside immediate wall stun angle.",
        action: "Land Q1 or Q2 first, then cast W and use E to keep distance while finishing the short trade."
      },
      {
        timing: "enemy_misstep" as const,
        signal: "Vayne wastes E or walks too close to wall-adjacent terrain.",
        action: "Commit a heavier trade with Q chain and hold E to avoid getting pinned into Condemn."
      }
    ];
    return {
      ...advice,
      level1to3Rules: rules,
      allInWindows: windows
    };
  }
  return advice;
}

function sanitizeMechanicsLine(line: string): string {
  let next = line.trim();
  if (!next) return next;

  // Generic impossible instruction cleanup.
  next = next.replace(
    /dodge\s+(?:a|an|the)?\s*point[\s-]?and[\s-]?click(?:\s+ability)?/gi,
    "play around point-and-click"
  );

  // Common false instruction in lane advice.
  next = next.replace(
    /dodge\s+(?:her|his|their)?\s*condemn/gi,
    "respect Condemn range and avoid wall angles"
  );

  next = next.replace(/\s{2,}/g, " ").trim();
  return next;
}

function sanitizeAdviceMechanics(
  advice: Pick<
    CoachMatchupResponseOutput,
    "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
  >
): Pick<
  CoachMatchupResponseOutput,
  "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
> {
  return {
    ...advice,
    earlyGamePlan: sanitizeMechanicsLine(advice.earlyGamePlan),
    level1to3Rules: advice.level1to3Rules.map((line) => sanitizeMechanicsLine(line)),
    allInWindows: advice.allInWindows.map((window) => ({
      ...window,
      signal: sanitizeMechanicsLine(window.signal),
      action: sanitizeMechanicsLine(window.action)
    })),
    commonMistakes: advice.commonMistakes.map((line) => sanitizeMechanicsLine(line)) as [string, string, string]
  };
}

export async function generateMatchupCoaching(
  input: CoachMatchupRequestInput,
  currentPatch: string,
  stats?: MatchupStats | null,
  partnerStats?: MatchupStats | null,
  geminiCoachService?: GeminiCoachService,
  options?: {
    sampleTarget?: number;
    providerSamples?: {
      riotGames: number;
      externalGames: number;
      effectiveGames: number;
    };
  }
): Promise<CoachMatchupResponseOutput> {
  const patch = input.patch ?? currentPatch;
  const lane = input.lane ?? "top";
  const difficulty = estimateDifficulty(input.playerChampion, input.enemyChampion, stats);
  const hasStats = Boolean((stats && stats.games > 0) || (partnerStats && partnerStats.games > 0));
  const playerTags = CHAMPION_TAGS[input.playerChampion] ?? [];
  const enemyTags = CHAMPION_TAGS[input.enemyChampion] ?? [];

  const fallbackAdvice: Pick<
    CoachMatchupResponseOutput,
    "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
  > = {
    earlyGamePlan:
      "Play for controlled wave states in the first 5 minutes. Keep your health high, avoid low-value extended trades, and trade only when the enemy uses a key cooldown or steps into your minion advantage.",
    level1to3Rules: [
      "Decide before lane if you can contest level 1 or should concede push.",
      "Track level 2 race and only trade on your minion timing advantage.",
      "Use short, repeatable trades unless enemy cooldowns are down."
    ],
    allInWindows: [
      {
        timing: "level_3" as const,
        signal: "Enemy uses mobility or defensive cooldown for wave control.",
        action: "Step up immediately for a commit trade, then disengage on your cooldown end."
      },
      {
        timing: "level_6" as const,
        signal: "Enemy is below 70% HP and wave is closer to your side.",
        action: "Use full combo and hold one key spell to secure the kill attempt."
      }
    ],
    runeAdjustments: fallbackRuneAdjustments(stats),
    commonMistakes: [
      "Trading into enemy cooldown advantage instead of waiting 3-5 seconds.",
      "Pushing wave without vision and losing health before level 6.",
      "Committing all-in without checking wave size and minion damage."
    ] as [string, string, string]
  };

  let generatedWithGemini = false;
  let advice: Pick<
    CoachMatchupResponseOutput,
    "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
  > = fallbackAdvice;
  let geminiFailureReason = "";
  if (geminiCoachService) {
    const geminiResult = await geminiCoachService.generateAdvice({
      playerChampion: input.playerChampion,
      enemyChampion: input.enemyChampion,
      playerChampionPartner: input.playerChampionPartner,
      enemyChampionPartner: input.enemyChampionPartner,
      lane,
      patch,
      difficulty,
      playerTags,
      enemyTags,
      stats,
      partnerStats
    });
    const geminiAdvice = geminiResult.advice;
    geminiFailureReason = geminiResult.failureReason ?? "";
    if (geminiAdvice) {
      advice = {
        ...geminiAdvice,
        commonMistakes: [...geminiAdvice.commonMistakes] as [string, string, string]
      };
      generatedWithGemini = true;
    }
  }

  advice = applyMatchupPriors(input, advice);
  advice = sanitizeAdviceMechanics(advice);

  const response: CoachMatchupResponseOutput = {
    matchup: {
      playerChampion: input.playerChampion,
      enemyChampion: input.enemyChampion,
      playerChampionPartner: input.playerChampionPartner,
      enemyChampionPartner: input.enemyChampionPartner,
      lane,
      patch
    },
    difficulty,
    earlyGamePlan: advice.earlyGamePlan,
    level1to3Rules: advice.level1to3Rules,
    allInWindows: advice.allInWindows,
    runeAdjustments: advice.runeAdjustments,
    commonMistakes: advice.commonMistakes,
    meta: {
      generatedAt: new Date().toISOString(),
      dataConfidence:
        hasStats && ((stats?.games ?? 0) + (partnerStats?.games ?? 0)) >= 24 ? "high" : hasStats ? "medium" : "low",
      sampleSize: (stats?.games ?? 0) + (partnerStats?.games ?? 0),
      winRate: stats ? Number(stats.winRate.toFixed(3)) : null,
      sampleTarget: Math.max(1, Math.floor(options?.sampleTarget ?? 10)),
      providerSamples: {
        riotGames: Math.max(0, Math.floor(options?.providerSamples?.riotGames ?? 0)),
        externalGames: Math.max(0, Math.floor(options?.providerSamples?.externalGames ?? 0)),
        effectiveGames: Math.max(
          0,
          Math.floor(options?.providerSamples?.effectiveGames ?? (stats?.games ?? 0) + (partnerStats?.games ?? 0))
        )
      },
      source: {
        stats: hasStats,
        tags: true,
        rag: generatedWithGemini,
        cacheHit: false
      },
      warnings: hasStats
        ? []
        : ["Using fallback coaching template until enough Riot matchup samples are available."]
    }
  };

  if (geminiCoachService && !generatedWithGemini) {
    response.meta.warnings = [
      geminiFailureReason
        ? `Gemini advice unavailable: ${geminiFailureReason}`
        : "Gemini advice unavailable for this request; using fallback coaching template.",
      ...response.meta.warnings
    ];
  }

  return response;
}
