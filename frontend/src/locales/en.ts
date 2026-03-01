const en = {
  app: {
    title: "Lane Matchup Coach",
    patch: "Patch {patch}",
    languageLabel: "Language",
    english: "English",
    japanese: "Japanese"
  },
  form: {
    lane: "Lane",
    lanes: {
      top: "Top",
      jungle: "Jungle",
      mid: "Mid",
      bot: "Bot (ADC + Support)"
    },
    playerRole: "I am playing",
    roles: {
      adc: "ADC",
      support: "Support"
    },
    allyBotlane: "Ally Botlane",
    enemyBotlane: "Enemy Botlane",
    allyLane: "Ally {lane}",
    enemyLane: "Enemy {lane}",
    champion: "Champion",
    submitIdle: "Get Matchup Coaching",
    submitLoading: "Generating..."
  },
  feedback: {
    chooseDifferent: "Choose two different champions.",
    botlaneDifferent: "For bot lane, choose both duo champions and keep ADC/support picks different.",
    autoRefresh: "Collecting more sample data... auto-refreshing every {seconds}s until {sampleTarget}+ total games are available."
  },
  result: {
    matchupDifficulty: "Matchup Difficulty",
    difficultyHelpAria: "Difficulty scale explanation",
    difficultyHelp:
      "Difficulty score uses weighted lane stats when available (gold diff @15, win rate, early skirmish kills minus deaths). Tiers: Easy, Favored, Even, Not Favored, Hard.",
    winRate: "Win rate",
    notAvailable: "N/A",
    duo: "Duo",
    combinedDuoPlan: "Combined Duo Plan (0-5 min)",
    earlyGamePlan: "Early Game Plan (0-5 min)",
    vsEnemyAdc: "How to play vs Enemy ADC",
    vsEnemySupport: "How to play vs Enemy Support",
    threatPattern: "Threat pattern",
    spacingRule: "Spacing rule",
    punishWindow: "Punish window",
    commonTrap: "Common trap",
    levelRules: "Level 1-3 Rules",
    allInWindows: "All-In Windows",
    runeAdjustments: "Rune Adjustments",
    source: "Source",
    noRuneAdjustment: "No rune adjustment suggested for this matchup.",
    keystone: "Keystone",
    secondary: "Secondary",
    shardNote: "Shard note",
    commonMistakes: "Common Mistakes",
    dataQuality: "Data Quality",
    confidence: "Confidence",
    sampleSize: "Sample size",
    statsUsed: "Stats used",
    generated: "Generated"
  },
  enums: {
    difficulty: {
      easy: "Easy",
      favored: "Favored",
      even: "Even",
      not_favored: "Not Favored",
      hard: "Hard"
    },
    runeSource: {
      gemini: "From Gemini",
      stats: "From matchup stats",
      none: "No adjustment"
    }
  },
  errors: {
    loadChampions: "Failed to load champions.",
    fetchCoaching: "Failed to fetch coaching output.",
    requestFailed: "Request failed ({status})"
  }
} as const;

export default en;
