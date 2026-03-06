import type { CoachMatchupRequestInput, CoachMatchupResponseOutput } from "../schemas/matchup.js";
import { CHAMPION_TAGS } from "../data/champions.js";
import type { MatchupStats } from "../types/stats.js";
import type { ChampionFacts, ChampionSpellFact } from "./championFactsService.js";
import { GeminiCoachService } from "./geminiCoachService.js";

type CoachLanguage = "en" | "ja";

interface ChampionFactsBundle {
  playerFacts?: ChampionFacts | null;
  enemyFacts?: ChampionFacts | null;
  playerPartnerFacts?: ChampionFacts | null;
  enemyPartnerFacts?: ChampionFacts | null;
}

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

function fallbackRuneAdjustments(
  stats?: MatchupStats | null,
  language: CoachLanguage = "en"
): CoachMatchupResponseOutput["runeAdjustments"] {
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
      reason:
        language === "ja"
          ? `このマッチアップで最も採用率が高いルーンです（採用率${pct}）。`
          : `Most common in this matchup sample (${pct} pick rate).`
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

  // Sona Q, W, E are targeted; only R (Crescendo) is a skillshot. Do not advise "dodge" for her basic abilities.
  next = next.replace(
    /dodge\s+(?:Sona'?s?|Sona)\s*(?:Q[,.]?\s*W[,.]?\s*E|Q\s*and\s*W|abilities?|basic\s*abilities?|poke)?/gi,
    "play around Sona's targeted Q/W/E (only her R is dodgeable)"
  );
  next = next.replace(
    /dodge\s+Sona'?s?\s*(?:Q|W|E)\b/gi,
    "play around Sona's targeted Q/W/E (only her R is dodgeable)"
  );

  // Common false instruction in lane advice.
  next = next.replace(
    /dodge\s+(?:her|his|their)?\s*condemn/gi,
    "respect Condemn range and avoid wall angles"
  );

  // Sona Q is targeted; minions don't block it. Fix "behind minions" vs Sona Q.
  next = next.replace(
    /stay\s+behind\s+minions\s+to\s+minimize\s+Sona'?s?\s*Q\s*harass/gi,
    "play around Sona's targeted Q (minions don't block it); respect her range and cooldowns"
  );
  next = next.replace(
    /behind\s+minions\s+to\s+(?:minimize|reduce|block)\s+Sona'?s?\s*(?:Q\s*)?harass/gi,
    "play around Sona's targeted Q (minions don't block it)"
  );

  next = next.replace(/\s{2,}/g, " ").trim();
  return next;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fix "coordinate with Nami" / "Nami's follow-up" when the player IS Nami (replace with ally reference). */
function fixSelfReferenceInLine(
  line: string,
  playerChampionName: string | undefined,
  allyLabel: string
): string {
  if (!line || !playerChampionName || playerChampionName.length < 2) return line;
  const escaped = escapeRegex(playerChampionName);
  let next = line;
  next = next.replace(
    new RegExp(`coordinate\\s+with\\s+(?:the\\s+)?${escaped}\\b`, "gi"),
    `coordinate with ${allyLabel}`
  );
  next = next.replace(
    new RegExp(`without\\s+(?:the\\s+)?${escaped}'s\\s+follow[- ]?up`, "gi"),
    `without ${allyLabel}'s follow-up`
  );
  next = next.replace(
    new RegExp(`without\\s+${escaped}'s\\s+follow[- ]?up`, "gi"),
    `without ${allyLabel}'s follow-up`
  );
  next = next.replace(
    new RegExp(`(?:without|lack of)\\s+${escaped}'s\\s+follow[- ]?up`, "gi"),
    `without ${allyLabel}'s follow-up`
  );
  return next.replace(/\s{2,}/g, " ").trim();
}

/** Append (Q)/(W)/(E)/(R) to champion ability names when missing. Uses ChampionFacts spell names. */
function ensureAbilityKeyInText(
  line: string,
  facts: ChampionFacts | null | undefined,
  language: CoachLanguage
): string {
  if (!line || !facts?.spellFacts?.length) return line;
  let next = line;
  const spellsByLength = [...facts.spellFacts].sort(
    (a, b) => (b.displayNameEn.length - a.displayNameEn.length) || (b.displayNameJa.length - a.displayNameJa.length)
  );
  for (const spell of spellsByLength) {
    const nameEn = spell.displayNameEn.trim();
    const nameJa = spell.displayNameJa.trim();
    const slot = spell.slot;
    for (const name of [nameEn, nameJa]) {
      if (!name || name.length < 2) continue;
      const escaped = escapeRegex(name);
      const re = new RegExp(`\\b(${escaped})\\b(?!\\s*\\([QWER]\\))`, "gi");
      next = next.replace(re, `$1 (${slot})`);
    }
  }
  return next.replace(/\s{2,}/g, " ").trim();
}

/** If commonTrap references the ally's ability names (support role), replace with a support-only fallback. */
function sanitizeCommonTrapForSupport(
  trap: string,
  partnerFacts: ChampionFacts | null | undefined,
  language: CoachLanguage,
  section: "vsEnemyAdc" | "vsEnemySupport",
  enemyChampion?: string
): string {
  if (!trap) return trap;
  const normalizedTrap = trap.toLowerCase();
  const allySpellNames: string[] = [];
  if (partnerFacts?.spellFacts?.length) {
    allySpellNames.push(
      ...partnerFacts.spellFacts.map((s) => s.displayNameEn.trim().toLowerCase()).filter((n) => n.length >= 3)
    );
  }
  if (allySpellNames.length === 0) {
    allySpellNames.push(
      "relentless pursuit",
      "ardent blaze",
      "piercing light",
      "the culling",
      "tumble",
      "condemn",
      "final hour",
      "peacemaker",
      "piltover peacemaker",
      "90 caliber net",
      "ace in the hole",
      "infinite duress"
    );
  }
  const hasAllySpellName = allySpellNames.some((name) => {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
    return re.test(normalizedTrap);
  });
  if (!hasAllySpellName) return trap;
  const isJa = language === "ja";
  if (section === "vsEnemyAdc") {
    return isJa ? "味方ADCが追従できない距離で先にエンゲージしてしまう。" : "Engaging while your ADC is still out of range to follow.";
  }
  const enemy = enemyChampion ?? (isJa ? "敵ADC" : "enemy ADC");
  return isJa
    ? `悪いタイミングでロームして、味方ADCを${enemy}相手に晒す。`
    : `Roaming on a bad timer and leaving your ADC exposed into ${enemy}.`;
}

function normalizeContentKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]/g, "")
    .trim();
}

function isNearDuplicateContent(a: string, b: string): boolean {
  const left = normalizeContentKey(a);
  const right = normalizeContentKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 28 && right.includes(left.slice(0, 28))) return true;
  if (right.length >= 28 && left.includes(right.slice(0, 28))) return true;
  return false;
}

function enforceAdviceStructure(
  advice: Pick<
    CoachMatchupResponseOutput,
    "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
  >,
  language: CoachLanguage
): Pick<
  CoachMatchupResponseOutput,
  "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
> {
  const fallbackRules =
    language === "ja"
      ? [
          "レベル1の主導権を争うか、プッシュを譲るかを事前に決める。",
          "レベル2先行とミニオン有利を確認してからトレードする。",
          "敵の主要スキル後に短いトレードを重ねる。"
        ]
      : [
          "Decide before lane whether to contest level 1 or concede push.",
          "Track level 2 race and trade only with minion advantage.",
          "Take short trades after enemy key cooldowns are used."
        ];
  const fallbackWindows =
    language === "ja"
      ? [
          {
            timing: "level_3" as const,
            signal: "敵が移動または防御スキルを使って波を触ったとき。",
            action: "すぐ前に出て短く仕掛け、返しを受ける前に離脱する。",
            isFallbackAction: true
          },
          {
            timing: "level_6" as const,
            signal: "敵HPが70%以下で、ウェーブ位置が自陣寄りのとき。",
            action: "フルコンボを通し、仕留め用の主要スキルを1つ温存する。",
            isFallbackAction: true
          }
        ]
      : [
          {
            timing: "level_3" as const,
            signal: "Enemy uses mobility or a defensive cooldown for wave control.",
            action: "Step up for a short commit trade, then disengage before return damage.",
            isFallbackAction: true
          },
          {
            timing: "level_6" as const,
            signal: "Enemy HP drops below 70% with a favorable wave position.",
            action: "Commit full combo and hold one key spell for secure finish.",
            isFallbackAction: true
          }
        ];

  const plan = advice.earlyGamePlan.trim();
  const dedupedRules = advice.level1to3Rules
    .map((rule) => rule.trim())
    .filter((rule) => rule.length >= 8 && rule.length <= 160)
    .filter((rule) => !isNearDuplicateContent(rule, plan))
    .filter((rule, idx, arr) => arr.findIndex((entry) => isNearDuplicateContent(entry, rule)) === idx);

  while (dedupedRules.length < 3) {
    dedupedRules.push(fallbackRules[dedupedRules.length]);
  }

  const dedupedWindows = advice.allInWindows
    .map((window) => ({
      ...window,
      signal: window.signal.trim(),
      action: window.action.trim()
    }))
    .filter((window) => window.signal.length >= 8 && window.action.length >= 8)
    .filter((window) => !isNearDuplicateContent(window.signal, plan))
    .filter((window) => !isNearDuplicateContent(window.action, plan))
    .slice(0, 5);

  while (dedupedWindows.length < 2) {
    dedupedWindows.push(fallbackWindows[dedupedWindows.length]);
  }

  return {
    ...advice,
    level1to3Rules: dedupedRules.slice(0, 5),
    allInWindows: dedupedWindows
  };
}

function applyFactGuardToLine(
  line: string,
  nonManaFacts: ChampionFacts[],
  language: CoachLanguage
): { value: string; changed: boolean } {
  const manaPattern = /\b(?:mana|oom|out of mana|mana-hungry|mana hungry)\b|マナ/i;
  if (!manaPattern.test(line)) {
    return { value: line, changed: false };
  }

  const normalizedLine = normalizeContentKey(line);
  const matchingFact = nonManaFacts.find((facts) => {
    const enName = normalizeContentKey(facts.displayNameEn);
    const jaName = normalizeContentKey(facts.displayNameJa);
    const canonical = normalizeContentKey(facts.canonicalName);
    return (
      (enName.length > 0 && normalizedLine.includes(enName)) ||
      (jaName.length > 0 && normalizedLine.includes(jaName)) ||
      (canonical.length > 0 && normalizedLine.includes(canonical))
    );
  });

  if (!matchingFact) {
    return { value: line, changed: false };
  }

  const championName = language === "ja" ? matchingFact.displayNameJa : matchingFact.displayNameEn;
  const replacement =
    language === "ja"
      ? `${championName}はマナ系リソースを使わないため、マナ管理ではなく体力・クールダウン・ウェーブ位置を重視する。`
      : `${championName} does not use mana resources, so focus on health, cooldowns, and wave position instead of mana management.`;
  return { value: replacement, changed: true };
}

function resolveMentionedSpell(
  line: string,
  facts: ChampionFacts
): { spell: ChampionSpellFact } | null {
  const normalizedLine = normalizeContentKey(line);
  const championLabels = [facts.displayNameEn, facts.displayNameJa, facts.canonicalName]
    .map((name) => normalizeContentKey(name))
    .filter((name, idx, arr) => name.length > 0 && arr.indexOf(name) === idx);
  if (championLabels.length === 0) return null;

  const hasChampionMention = championLabels.some((label) => normalizedLine.includes(label));
  if (!hasChampionMention) return null;

  const slots: Array<"Q" | "W" | "E" | "R"> = ["Q", "W", "E", "R"];
  for (const slot of slots) {
    const slotLower = slot.toLowerCase();
    const hasSlotMention =
      championLabels.some((label) => normalizedLine.includes(`${label}${slotLower}`)) ||
      championLabels.some((label) => normalizedLine.includes(`${slotLower}${label}`)) ||
      new RegExp(`\\b${slotLower}\\b`, "i").test(line);
    if (!hasSlotMention) continue;
    const spell = facts.spellFacts.find((entry) => entry.slot === slot);
    if (spell) return { spell };
  }
  return null;
}

function applySpellRoleFactGuardToLine(
  line: string,
  factsList: ChampionFacts[],
  language: CoachLanguage
): { value: string; changed: boolean } {
  const disengagePattern = /\bdisengage\b|\bretreat\b|\bescape\b|離脱|逃げ|撤退|引き/i;
  const explicitNegation = /\bnot\s+(?:a\s+)?disengage\b|離脱(?:スキル|手段)?ではない/i;
  if (!disengagePattern.test(line) || explicitNegation.test(line)) {
    return { value: line, changed: false };
  }

  const lowerLine = line.toLowerCase();
  const hasGenericSpellReference = /\bq\b|\bw\b|\be\b|\br\b/i.test(lowerLine);
  if (!hasGenericSpellReference) {
    return { value: line, changed: false };
  }

  for (const facts of factsList) {
    const mentioned = resolveMentionedSpell(line, facts);
    if (!mentioned) continue;
    if (mentioned.spell.roles.includes("disengage")) {
      return { value: line, changed: false };
    }
    const championName = language === "ja" ? facts.displayNameJa : facts.displayNameEn;
    const spellName = language === "ja" ? mentioned.spell.displayNameJa : mentioned.spell.displayNameEn;
    const roleTextEn = mentioned.spell.roles.length > 0 ? mentioned.spell.roles.join("/") : "utility";
    const replacement =
      language === "ja"
        ? `${championName}の${mentioned.spell.slot}（${spellName}）は主に${mentioned.spell.roles.includes("cc") ? "拘束" : "圧力"}用で、離脱は間合い管理や移動スキルで行う。`
        : `${championName} ${mentioned.spell.slot} (${spellName}) is mainly a ${roleTextEn} tool, not a primary disengage; disengage with spacing or true mobility tools.`;
    return { value: replacement, changed: true };
  }

  return { value: line, changed: false };
}

function enforceChampionFactConsistency(
  advice: Pick<
    CoachMatchupResponseOutput,
    "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
  >,
  botlaneAdvice: CoachMatchupResponseOutput["botlaneAdvice"],
  facts: ChampionFactsBundle | undefined,
  language: CoachLanguage
): {
  advice: Pick<
    CoachMatchupResponseOutput,
    "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
  >;
  botlaneAdvice: CoachMatchupResponseOutput["botlaneAdvice"];
  interventionCount: number;
} {
  const allFacts = [
    facts?.playerFacts,
    facts?.enemyFacts,
    facts?.playerPartnerFacts,
    facts?.enemyPartnerFacts
  ].filter((factsEntry): factsEntry is ChampionFacts => Boolean(factsEntry));
  const nonManaFacts = allFacts.filter((factsEntry) => factsEntry.resourceType !== "mana");
  if (allFacts.length === 0) {
    return { advice, botlaneAdvice, interventionCount: 0 };
  }

  let interventionCount = 0;
  const scrub = (line: string): string => {
    const mechanicsSanitized = sanitizeMechanicsLine(line);
    const manaGuarded = applyFactGuardToLine(mechanicsSanitized, nonManaFacts, language);
    if (manaGuarded.changed) {
      interventionCount += 1;
      return manaGuarded.value;
    }
    const spellGuarded = applySpellRoleFactGuardToLine(manaGuarded.value, allFacts, language);
    if (spellGuarded.changed) interventionCount += 1;
    return spellGuarded.value;
  };

  const nextAdvice = {
    ...advice,
    earlyGamePlan: scrub(advice.earlyGamePlan),
    level1to3Rules: advice.level1to3Rules.map((line) => scrub(line)),
    allInWindows: advice.allInWindows.map((window) => ({
      ...window,
      signal: scrub(window.signal),
      action: scrub(window.action)
    })),
    commonMistakes: advice.commonMistakes.map((line) => scrub(line)) as [string, string, string]
  };

  if (!botlaneAdvice) {
    return { advice: nextAdvice, botlaneAdvice, interventionCount };
  }

  const nextBotlaneAdvice: NonNullable<CoachMatchupResponseOutput["botlaneAdvice"]> = {
    ...botlaneAdvice,
    vsEnemyAdc: {
      ...botlaneAdvice.vsEnemyAdc,
      threatPattern: scrub(botlaneAdvice.vsEnemyAdc.threatPattern),
      spacingRule: scrub(botlaneAdvice.vsEnemyAdc.spacingRule),
      punishWindow: scrub(botlaneAdvice.vsEnemyAdc.punishWindow),
      commonTrap: scrub(botlaneAdvice.vsEnemyAdc.commonTrap)
    },
    vsEnemySupport: {
      ...botlaneAdvice.vsEnemySupport,
      threatPattern: scrub(botlaneAdvice.vsEnemySupport.threatPattern),
      spacingRule: scrub(botlaneAdvice.vsEnemySupport.spacingRule),
      punishWindow: scrub(botlaneAdvice.vsEnemySupport.punishWindow),
      commonTrap: scrub(botlaneAdvice.vsEnemySupport.commonTrap)
    }
  };

  return { advice: nextAdvice, botlaneAdvice: nextBotlaneAdvice, interventionCount };
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

function fallbackBotlaneAdvice(
  input: Pick<
    CoachMatchupRequestInput,
    "playerChampion" | "enemyChampion" | "playerChampionPartner" | "enemyChampionPartner" | "playerRole"
  >,
  language: CoachLanguage = "en"
): NonNullable<CoachMatchupResponseOutput["botlaneAdvice"]> {
  const isJa = language === "ja";
  const role = input.playerRole === "support" ? "support" : "adc";
  const allySupport = input.playerChampionPartner ?? (isJa ? "味方サポート" : "your support");
  const enemySupport = input.enemyChampionPartner ?? (isJa ? "敵サポート" : "enemy support");

  const vsEnemyAdc =
    role === "adc"
      ? {
          threatPattern: isJa
            ? `${input.enemyChampion}は、あなたのCSタイミングで通常攻撃を継続できると最も強い。`
            : `${input.enemyChampion} is strongest when they get uninterrupted autos during your CS timing.`,
          spacingRule: isJa
            ? `${input.enemyChampion}に無償AAを許さない間合いを保ってラストヒットを取る。`
            : `Hold spacing so ${input.enemyChampion} cannot auto for free while you contest last hits.`,
          punishWindow: isJa
            ? `${input.enemyChampion}がウェーブに火力スキルを使うか、ポークを外した直後にトレードする。`
            : `Trade when ${input.enemyChampion} uses a damage cooldown on the wave or misses poke.`,
          commonTrap: isJa
            ? `${allySupport}より前に出すぎて孤立した1v1トレードを受ける。`
            : `Overextending past ${allySupport} and taking isolated 1v1 trades.`
        }
      : {
          threatPattern: isJa
            ? `${input.enemyChampion}は、味方ADCに即時ピールが届かない時に火力を出しやすい。`
            : `${input.enemyChampion} spikes when they can focus your ADC without immediate peel.`,
          spacingRule: isJa
            ? `味方ADCと角度を合わせて位置取りし、${input.enemyChampion}の無償攻撃を防ぐ。`
            : `Shadow your ADC and keep a matching angle so ${input.enemyChampion} cannot free-hit.`,
          punishWindow: isJa
            ? `${input.enemyChampion}がファーム用スキルを使った直後に前へ出て圧力をかける。`
            : `Step up when ${input.enemyChampion} burns a farm cooldown and cannot return damage quickly.`,
          commonTrap: isJa
            ? "味方ADCが追従できない距離で先にエンゲージしてしまう。"
            : "Engaging while your ADC is still out of range to follow."
        };

  const vsEnemySupport =
    role === "adc"
      ? {
          threatPattern: isJa
            ? `${enemySupport}はエンゲージとCCのCD管理でレーン開始を作る。`
            : `${enemySupport} controls lane starts through engage and crowd-control cooldowns.`,
          spacingRule: isJa
            ? `${enemySupport}の位置を先に見て、主要スキル後にだけCSへ寄る。`
            : `Track ${enemySupport} position first, then walk up for farm when key threat is down.`,
          punishWindow: isJa
            ? `${enemySupport}がエンゲージを外すか、主力ポークを防御に使った直後にトレードする。`
            : `Trade right after ${enemySupport} misses engage or uses primary poke defensively.`,
          commonTrap: isJa
            ? `${enemySupport}の射程に、ミニオンカバーや味方サポート位置確認なしで入る。`
            : `Walking into ${enemySupport} range without minion cover or ally support position.`
        }
      : {
          threatPattern: isJa
            ? `${enemySupport}は視界管理とエンゲージタイミングでテンポを作る。`
            : `${enemySupport} dictates tempo with vision control and engage timing.`,
          spacingRule: isJa
            ? `${enemySupport}の動きを合わせて追い、味方ADCを守りながらレーン空間を確保する。`
            : `Mirror ${enemySupport} movement to keep your ADC protected and contest lane space.`,
          punishWindow: isJa
            ? `${enemySupport}がエンゲージを外し、再度仕掛けられない間に前へ出る。`
            : `Take lane space when ${enemySupport} misses engage and has no immediate re-threat.`,
          commonTrap: isJa
            ? `悪いタイミングでロームして、味方ADCを${input.enemyChampion}相手に晒す。`
            : `Roaming on a bad timer and leaving your ADC exposed into ${input.enemyChampion}.`
        };

  return {
    playerRole: role,
    vsEnemyAdc,
    vsEnemySupport
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
    externalSource?: {
      provider: string;
      status: "success" | "cache_hit" | "http_error" | "timeout" | "network_error" | "parse_miss";
      failureReason?: string;
      httpStatus?: number;
    } | null;
    botlaneContexts?: {
      playerRole: "adc" | "support";
      allyAdc: string;
      allySupport: string;
      enemyAdc: string;
      enemySupport: string;
    };
    championFacts?: ChampionFactsBundle;
  }
): Promise<CoachMatchupResponseOutput> {
  const language: CoachLanguage = input.language === "ja" ? "ja" : "en";
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
      language === "ja"
        ? "最初の5分はウェーブ管理を優先し、体力を維持して無理な長期トレードを避ける。敵の主要スキル使用後やミニオン有利の時だけトレードする。"
        : "Play for controlled wave states in the first 5 minutes. Keep your health high, avoid low-value extended trades, and trade only when the enemy uses a key cooldown or steps into your minion advantage.",
    level1to3Rules:
      language === "ja"
        ? [
            "レーン前にレベル1を争うか、プッシュを譲るかを決める。",
            "レベル2先行を意識し、ミニオン有利時のみトレードする。",
            "敵の主要スキルが落ちている時だけ短い反復トレードを行う。"
          ]
        : [
            "Decide before lane if you can contest level 1 or should concede push.",
            "Track level 2 race and only trade on your minion timing advantage.",
            "Use short, repeatable trades unless enemy cooldowns are down."
          ],
    allInWindows: [
      {
        timing: "level_3" as const,
        signal:
          language === "ja"
            ? "敵がウェーブ管理に移動系または防御系スキルを使った。"
            : "Enemy uses mobility or defensive cooldown for wave control.",
        action:
          language === "ja"
            ? "すぐ前に出て仕掛け、こちらのCD終了に合わせて離脱する。"
            : "Step up immediately for a commit trade, then disengage on your cooldown end.",
        isFallbackAction: true
      },
      {
        timing: "level_6" as const,
        signal:
          language === "ja"
            ? "敵HPが70%未満で、ウェーブがこちら側にある。"
            : "Enemy is below 70% HP and wave is closer to your side.",
        action:
          language === "ja"
            ? "フルコンボを使い、仕留め用に主要スキルを1つ温存する。"
            : "Use full combo and hold one key spell to secure the kill attempt.",
        isFallbackAction: true
      }
    ],
    runeAdjustments: fallbackRuneAdjustments(stats, language),
    commonMistakes: (
      language === "ja"
        ? [
            "敵スキル有利の時間に待たずにトレードしてしまう。",
            "視界なしでウェーブを押し、レベル6前に体力を失う。",
            "ウェーブ量やミニオンダメージ確認なしでオールインする。"
          ]
        : [
            "Trading into enemy cooldown advantage instead of waiting 3-5 seconds.",
            "Pushing wave without vision and losing health before level 6.",
            "Committing all-in without checking wave size and minion damage."
          ]
    ) as [string, string, string]
  };

  let generatedWithGemini = false;
  let advice: Pick<
    CoachMatchupResponseOutput,
    "earlyGamePlan" | "level1to3Rules" | "allInWindows" | "runeAdjustments" | "commonMistakes"
  > = fallbackAdvice;
  let botlaneAdvice =
    lane === "bot" && input.playerRole
      ? fallbackBotlaneAdvice({
          playerChampion: options?.botlaneContexts?.allyAdc ?? input.playerChampion,
          enemyChampion: options?.botlaneContexts?.enemyAdc ?? input.enemyChampion,
          playerChampionPartner: options?.botlaneContexts?.allySupport ?? input.playerChampionPartner,
          enemyChampionPartner: options?.botlaneContexts?.enemySupport ?? input.enemyChampionPartner,
          playerRole: options?.botlaneContexts?.playerRole ?? input.playerRole
        }, language)
      : undefined;
  let geminiFailureReason = "";
  if (geminiCoachService) {
    const geminiResult = await geminiCoachService.generateAdvice({
      playerChampion: input.playerChampion,
      enemyChampion: input.enemyChampion,
      playerChampionPartner: input.playerChampionPartner,
      enemyChampionPartner: input.enemyChampionPartner,
      playerRole: input.playerRole,
      lane,
      patch,
      difficulty,
      playerTags,
      enemyTags,
      stats,
      partnerStats,
      language,
      championFacts: options?.championFacts
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
    if (geminiResult.botlaneAdvice && lane === "bot") {
      botlaneAdvice = geminiResult.botlaneAdvice;
    }
  }

  advice = applyMatchupPriors(input, advice);
  advice = sanitizeAdviceMechanics(advice);
  advice = enforceAdviceStructure(advice, language);
  const factGuard = enforceChampionFactConsistency(advice, botlaneAdvice, options?.championFacts, language);
  advice = factGuard.advice;
  botlaneAdvice = factGuard.botlaneAdvice;

  if (lane === "bot" && input.playerRole) {
    const playerChampionName =
      input.playerRole === "support" ? (input.playerChampionPartner ?? "") : input.playerChampion;
    const allyLabel = input.playerRole === "support" ? "your ADC" : "your support";
    const fix = (line: string) => fixSelfReferenceInLine(line, playerChampionName, allyLabel);
    advice = {
      ...advice,
      earlyGamePlan: fix(advice.earlyGamePlan),
      level1to3Rules: advice.level1to3Rules.map(fix),
      allInWindows: advice.allInWindows.map((w) => ({ ...w, signal: fix(w.signal), action: fix(w.action) })),
      commonMistakes: advice.commonMistakes.map(fix) as [string, string, string]
    };
    if (botlaneAdvice) {
      botlaneAdvice = {
        ...botlaneAdvice,
        vsEnemyAdc: {
          ...botlaneAdvice.vsEnemyAdc,
          threatPattern: fix(botlaneAdvice.vsEnemyAdc.threatPattern),
          spacingRule: fix(botlaneAdvice.vsEnemyAdc.spacingRule),
          punishWindow: fix(botlaneAdvice.vsEnemyAdc.punishWindow),
          commonTrap: fix(botlaneAdvice.vsEnemyAdc.commonTrap)
        },
        vsEnemySupport: {
          ...botlaneAdvice.vsEnemySupport,
          threatPattern: fix(botlaneAdvice.vsEnemySupport.threatPattern),
          spacingRule: fix(botlaneAdvice.vsEnemySupport.spacingRule),
          punishWindow: fix(botlaneAdvice.vsEnemySupport.punishWindow),
          commonTrap: fix(botlaneAdvice.vsEnemySupport.commonTrap)
        }
      };
    }
    const playerFacts = options?.championFacts?.playerFacts;
    const ensureKeys = (text: string) => ensureAbilityKeyInText(text, playerFacts, language);
    advice = {
      ...advice,
      earlyGamePlan: ensureKeys(advice.earlyGamePlan),
      level1to3Rules: advice.level1to3Rules.map(ensureKeys),
      commonMistakes: advice.commonMistakes.map(ensureKeys) as [string, string, string]
    };
    if (botlaneAdvice) {
      botlaneAdvice = {
        ...botlaneAdvice,
        vsEnemyAdc: {
          ...botlaneAdvice.vsEnemyAdc,
          threatPattern: ensureKeys(botlaneAdvice.vsEnemyAdc.threatPattern),
          spacingRule: ensureKeys(botlaneAdvice.vsEnemyAdc.spacingRule),
          punishWindow: ensureKeys(botlaneAdvice.vsEnemyAdc.punishWindow),
          commonTrap: ensureKeys(botlaneAdvice.vsEnemyAdc.commonTrap)
        },
        vsEnemySupport: {
          ...botlaneAdvice.vsEnemySupport,
          threatPattern: ensureKeys(botlaneAdvice.vsEnemySupport.threatPattern),
          spacingRule: ensureKeys(botlaneAdvice.vsEnemySupport.spacingRule),
          punishWindow: ensureKeys(botlaneAdvice.vsEnemySupport.punishWindow),
          commonTrap: ensureKeys(botlaneAdvice.vsEnemySupport.commonTrap)
        }
      };
    }
    if (
      input.playerRole === "support" &&
      botlaneAdvice
    ) {
      const partnerFacts = options?.championFacts?.playerPartnerFacts;
      const sanitizeTrap = (trap: string, section: "vsEnemyAdc" | "vsEnemySupport") =>
        sanitizeCommonTrapForSupport(trap, partnerFacts, language, section, input.enemyChampion);
      botlaneAdvice = {
        ...botlaneAdvice,
        vsEnemyAdc: {
          ...botlaneAdvice.vsEnemyAdc,
          commonTrap: sanitizeTrap(botlaneAdvice.vsEnemyAdc.commonTrap, "vsEnemyAdc")
        },
        vsEnemySupport: {
          ...botlaneAdvice.vsEnemySupport,
          commonTrap: sanitizeTrap(botlaneAdvice.vsEnemySupport.commonTrap, "vsEnemySupport")
        }
      };
    }
  } else if (options?.championFacts?.playerFacts) {
    const playerFacts = options.championFacts.playerFacts;
    const ensureKeys = (text: string) => ensureAbilityKeyInText(text, playerFacts, language);
    advice = {
      ...advice,
      earlyGamePlan: ensureKeys(advice.earlyGamePlan),
      level1to3Rules: advice.level1to3Rules.map(ensureKeys),
      commonMistakes: advice.commonMistakes.map(ensureKeys) as [string, string, string]
    };
  }

  const response: CoachMatchupResponseOutput = {
    matchup: {
      playerChampion: input.playerChampion,
      enemyChampion: input.enemyChampion,
      playerChampionPartner: input.playerChampionPartner,
      enemyChampionPartner: input.enemyChampionPartner,
      playerRole: input.playerRole,
      lane,
      patch
    },
    difficulty,
    earlyGamePlan: advice.earlyGamePlan,
    level1to3Rules: advice.level1to3Rules,
    allInWindows: advice.allInWindows,
    runeAdjustments: advice.runeAdjustments,
    commonMistakes: advice.commonMistakes,
    botlaneAdvice,
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
      externalSource: options?.externalSource ?? null,
      source: {
        stats: hasStats,
        tags: true,
        rag: generatedWithGemini,
        cacheHit: false
      },
      warnings: hasStats
        ? []
        : [
            language === "ja"
              ? "十分なマッチアップサンプルが集まるまで、フォールバック用コーチングテンプレートを使用しています。"
              : "Using fallback coaching template until enough matchup samples are available."
          ]
    }
  };

  if (geminiCoachService && !generatedWithGemini) {
    response.meta.warnings = [
      geminiFailureReason
        ? language === "ja"
          ? `Geminiアドバイスを利用できません: ${geminiFailureReason}`
          : `Gemini advice unavailable: ${geminiFailureReason}`
        : language === "ja"
          ? "このリクエストではGeminiアドバイスを利用できないため、フォールバック用コーチングテンプレートを使用しています。"
          : "Gemini advice unavailable for this request; using fallback coaching template.",
      ...response.meta.warnings
    ];
  }
  if (factGuard.interventionCount > 0) {
    response.meta.warnings = [
      language === "ja"
        ? `事実整合チェックにより${factGuard.interventionCount}件の文言を補正しました。`
        : `Fact guard corrected ${factGuard.interventionCount} generated line(s).`,
      ...response.meta.warnings
    ];
  }

  return response;
}
