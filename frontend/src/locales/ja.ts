const ja = {
  app: {
    title: "レーン相性コーチ",
    patch: "パッチ {patch}",
    languageLabel: "言語",
    english: "英語",
    japanese: "日本語"
  },
  form: {
    lane: "レーン",
    lanes: {
      top: "トップ",
      jungle: "ジャングル",
      mid: "ミッド",
      bot: "ボットレーン（ADC＋サポート）"
    },
    playerRole: "自分のロール",
    roles: {
      adc: "ADC",
      support: "サポート"
    },
    allyBotlane: "味方ボットレーン",
    enemyBotlane: "敵ボットレーン",
    allyLane: "味方 {lane}",
    enemyLane: "敵 {lane}",
    champion: "チャンピオン",
    submitIdle: "相性コーチングを取得",
    submitLoading: "生成中..."
  },
  feedback: {
    chooseDifferent: "異なる2体のチャンピオンを選んでください。",
    botlaneDifferent: "ボットレーンでは両デュオを選び、ADCとサポートが同じにならないようにしてください。",
    autoRefresh: "サンプルデータを収集中... {seconds}秒ごとに自動更新し、合計{sampleTarget}試合以上になるまで続けます。"
  },
  result: {
    matchupDifficulty: "相性難易度",
    difficultyHelpAria: "難易度スケールの説明",
    difficultyHelp:
      "難易度は、利用可能な場合に重み付きレーン統計（15分時点ゴールド差、勝率、序盤小競り合いキル-デス）で算出します。区分: かなり有利、有利、五分、不利、かなり不利。",
    winRate: "勝率",
    notAvailable: "N/A",
    duo: "デュオ",
    combinedDuoPlan: "デュオ総合プラン (0-5分)",
    earlyGamePlan: "序盤プラン (0-5分)",
    vsEnemyAdc: "敵ADCへの立ち回り",
    vsEnemySupport: "敵サポートへの立ち回り",
    threatPattern: "脅威パターン",
    spacingRule: "間合いルール",
    punishWindow: "仕掛けるタイミング",
    commonTrap: "よくある罠",
    levelRules: "レベル1-3のルール",
    allInWindows: "オールインのタイミング",
    runeAdjustments: "ルーン調整",
    source: "ソース",
    noRuneAdjustment: "このマッチアップではルーン調整の提案はありません。",
    keystone: "キーストーン",
    secondary: "サブルーン",
    shardNote: "シャードメモ",
    commonMistakes: "よくあるミス",
    dataQuality: "データ品質",
    confidence: "信頼度",
    sampleSize: "サンプル数",
    statsUsed: "統計利用",
    generated: "生成日時"
  },
  enums: {
    difficulty: {
      easy: "かなり有利",
      favored: "有利",
      even: "五分",
      not_favored: "不利",
      hard: "かなり不利"
    },
    runeSource: {
      gemini: "Gemini生成",
      stats: "マッチアップ統計",
      none: "調整なし"
    }
  },
  errors: {
    loadChampions: "チャンピオンの読み込みに失敗しました。",
    fetchCoaching: "コーチング結果の取得に失敗しました。",
    requestFailed: "リクエスト失敗 ({status})"
  }
} as const;

export default ja;
