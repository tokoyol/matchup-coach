export interface MatchupStats {
  patch: string;
  games: number;
  winRate: number;
  goldDiff15: number;
  pre6KillRate: number;
  earlyDeathRate: number;
  runeUsage: Array<{ keystoneId: number; count: number; pct: number }>;
  firstItemUsage: Array<{ itemId: number; count: number; pct: number }>;
  computedAt: string;
}
