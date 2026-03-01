import type { CoachLane } from "../data/champions.js";

export type MatchupDifficulty = "easy" | "favored" | "even" | "not_favored" | "hard";
export type BotPlayerRole = "adc" | "support";

export type AllInTiming =
  | "level_2"
  | "level_3"
  | "level_6"
  | "first_item"
  | "enemy_misstep";

export interface CoachMatchupRequest {
  playerChampion: string;
  enemyChampion: string;
  playerChampionPartner?: string;
  enemyChampionPartner?: string;
  playerRole?: BotPlayerRole;
  lane?: CoachLane;
  patch?: string;
  language?: "en" | "ja";
}

export interface AllInWindow {
  timing: AllInTiming;
  signal: string;
  action: string;
}

export interface RuneAdjustments {
  keystone: {
    recommended: string;
    reason: string;
  };
  secondary: {
    tree: string;
    reason: string;
  };
  shardsNote: string;
}

export interface BotEnemyAdvice {
  threatPattern: string;
  spacingRule: string;
  punishWindow: string;
  commonTrap: string;
}

export interface CoachMatchupResponse {
  matchup: {
    playerChampion: string;
    enemyChampion: string;
    playerChampionPartner?: string;
    enemyChampionPartner?: string;
    playerRole?: BotPlayerRole;
    lane: CoachLane;
    patch: string;
  };
  difficulty: MatchupDifficulty;
  earlyGamePlan: string;
  level1to3Rules: string[];
  allInWindows: AllInWindow[];
  runeAdjustments: RuneAdjustments;
  commonMistakes: [string, string, string];
  botlaneAdvice?: {
    playerRole: BotPlayerRole;
    vsEnemyAdc: BotEnemyAdvice;
    vsEnemySupport: BotEnemyAdvice;
  };
  meta: {
    generatedAt: string;
    dataConfidence: "low" | "medium" | "high";
    sampleSize: number;
    winRate: number | null;
    sampleTarget: number;
    providerSamples: {
      riotGames: number;
      externalGames: number;
      effectiveGames: number;
    };
    externalSource: {
      provider: string;
      status: "success" | "cache_hit" | "http_error" | "timeout" | "network_error" | "parse_miss";
      failureReason?: string;
      httpStatus?: number;
    } | null;
    source: {
      stats: boolean;
      tags: boolean;
      rag: boolean;
      cacheHit: boolean;
    };
    warnings: string[];
  };
}
