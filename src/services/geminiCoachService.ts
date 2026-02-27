import { z } from "zod";
import type { MatchupStats } from "../types/stats.js";
import type { CoachLane } from "../data/champions.js";

const allInWindowFlexibleSchema = z.union([
  z.object({
    timing: z.enum(["level_2", "level_3", "level_6", "first_item", "enemy_misstep"]),
    signal: z.string().min(1).max(220),
    action: z.string().min(1).max(280)
  }),
  z.string().min(1).max(320)
]);

const geminiAdviceSchema = z.object({
  earlyGamePlan: z.string().min(1).max(800),
  level1to3Rules: z.array(z.string().min(1).max(220)).min(1).max(8),
  allInWindows: z.array(allInWindowFlexibleSchema).min(1).max(8),
  runeAdjustments: z.object({
    keystone: z.object({
      recommended: z.string().min(1).max(60),
      reason: z.string().min(1).max(240)
    }),
    secondary: z.object({
      tree: z.string().min(1).max(60),
      reason: z.string().min(1).max(240)
    }),
    shardsNote: z.string().min(1).max(220)
  }),
  commonMistakes: z.array(z.string().min(1).max(220)).min(1).max(8)
});

type GeminiAdviceRaw = z.infer<typeof geminiAdviceSchema>;

const botEnemySectionSchema = z.object({
  threatPattern: z.string().min(1).max(280),
  spacingRule: z.string().min(1).max(260),
  punishWindow: z.string().min(1).max(260),
  commonTrap: z.string().min(1).max(260)
});

const geminiBotEnemyAdviceSchema = z.object({
  vsEnemyAdc: botEnemySectionSchema,
  vsEnemySupport: botEnemySectionSchema
});

export interface GeminiAdvice {
  earlyGamePlan: string;
  level1to3Rules: string[];
  allInWindows: Array<{
    timing: "level_2" | "level_3" | "level_6" | "first_item" | "enemy_misstep";
    signal: string;
    action: string;
  }>;
  runeAdjustments: {
    keystone: { recommended: string; reason: string };
    secondary: { tree: string; reason: string };
    shardsNote: string;
  };
  commonMistakes: string[];
}

export interface GeminiBotEnemyAdvice {
  playerRole: "adc" | "support";
  vsEnemyAdc: {
    threatPattern: string;
    spacingRule: string;
    punishWindow: string;
    commonTrap: string;
  };
  vsEnemySupport: {
    threatPattern: string;
    spacingRule: string;
    punishWindow: string;
    commonTrap: string;
  };
}

interface GeminiCoachServiceOptions {
  apiKey?: string;
  apiKeys?: string[];
  model: string;
}

export interface GeminiStatus {
  configured: boolean;
  model: string;
  modelReachable: boolean;
  generationAvailable: boolean;
  status: "ok" | "quota_exhausted" | "model_not_found" | "network_error" | "api_error";
  message: string;
  httpStatus?: number;
}

export interface GeminiAdviceResult {
  advice: GeminiAdvice | null;
  botlaneAdvice?: GeminiBotEnemyAdvice;
  failureReason?: string;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function cleanLine(value: string): string {
  return value
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\-\*\d\.\)\s]+/, "")
    .replace(/^"?[A-Za-z_][A-Za-z0-9_]*"?\s*:\s*/g, "")
    .replace(/"/g, "")
    .replace(/^"+|"+$/g, "")
    .replace(/[\"“”]+$/g, "")
    .replace(/\\$/g, "")
    .replace(/,$/, "")
    .trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).trim();
}

function normalizeFromPlainText(raw: string): GeminiAdvice | null {
  const cleaned = raw
    .replace(/```(?:json)?/gi, "")
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => Boolean(line))
    .filter((line) => !/^(?:\{|\}|\[|\]|,)$/.test(line))
    .filter((line) => !/^"?\w+"?\s*:\s*\[?$/.test(line));
  if (cleaned.length === 0) return null;

  const firstLong = clip(cleaned.find((line) => line.length >= 40) ?? cleaned[0], 600);
  const bullets = cleaned.filter((line) => line.length >= 8).map((line) => clip(line, 220));
  const rules = bullets
    .filter((line) => line !== firstLong)
    .slice(0, 3)
    .map((line) => clip(line, 160));
  while (rules.length < 3) rules.push("Trade only when enemy key cooldowns are unavailable.");

  const mistakes = bullets.slice(-3);
  while (mistakes.length < 3) mistakes.unshift("Forcing trades without cooldown advantage.");

  return {
    earlyGamePlan: firstLong,
    level1to3Rules: rules.slice(0, 5),
    allInWindows: [
      {
        timing: "level_3",
        signal: clip(bullets[3] ?? "Enemy key defensive cooldown is down.", 160),
        action: clip("Take a short commit trade and disengage before return damage.", 220)
      },
      {
        timing: "level_6",
        signal: clip(bullets[4] ?? "Enemy HP is below 70% and wave is favorable.", 160),
        action: clip("Commit full combo with spacing and hold one spell for finish.", 220)
      }
    ],
    runeAdjustments: {
      keystone: {
        recommended: "",
        reason: ""
      },
      secondary: {
        tree: "",
        reason: ""
      },
      shardsNote: ""
    },
    commonMistakes: mistakes.slice(0, 3).map((line) => clip(line, 180))
  };
}

function tryLenientParse(jsonText: string): unknown | null {
  const candidates = [
    jsonText,
    `{${jsonText}}`,
    jsonText.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]")
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return null;
}

function normalizeAdvice(input: GeminiAdviceRaw): GeminiAdvice {
  const levelRules = input.level1to3Rules.map(cleanLine).filter(Boolean).slice(0, 5).map((line) => clip(line, 160));
  while (levelRules.length < 3) {
    levelRules.push("Play around cooldowns and minion advantage before trading.");
  }

  const windows = input.allInWindows
    .map((window, idx) => {
      if (typeof window === "string") {
        const cleaned = cleanLine(window);
        return {
          timing: idx === 0 ? ("level_3" as const) : ("level_6" as const),
          signal: clip(cleaned, 160),
          action: clip("Take a short commit trade and disengage if the enemy cooldowns return.", 220)
        };
      }
      return {
        timing: window.timing,
        signal: clip(cleanLine(window.signal), 160),
        action: clip(cleanLine(window.action), 220)
      };
    })
    .filter((window) => window.signal.length > 0 && window.action.length > 0)
    .slice(0, 5);
  while (windows.length < 2) {
    windows.push({
      timing: windows.length === 0 ? "level_3" : "level_6",
      signal: "Enemy key defensive cooldown is unavailable.",
      action: clip("Take a short commit trade and disengage after your combo.", 220)
    });
  }

  const mistakes = input.commonMistakes.map(cleanLine).filter(Boolean).slice(0, 3).map((line) => clip(line, 180));
  while (mistakes.length < 3) {
    mistakes.push("Taking low-value trades when enemy cooldowns are up.");
  }

  const plan = cleanLine(input.earlyGamePlan);
  return {
    earlyGamePlan:
      plan.length >= 20
        ? clip(plan, 600)
        : "Play a controlled early lane, preserve health, and only trade when enemy cooldowns are down.",
    level1to3Rules: levelRules,
    allInWindows: windows,
    runeAdjustments: {
      keystone: {
        recommended: clip(cleanLine(input.runeAdjustments.keystone.recommended), 40),
        reason: clip(cleanLine(input.runeAdjustments.keystone.reason), 180)
      },
      secondary: {
        tree: clip(cleanLine(input.runeAdjustments.secondary.tree), 40),
        reason: clip(cleanLine(input.runeAdjustments.secondary.reason), 180)
      },
      shardsNote: clip(cleanLine(input.runeAdjustments.shardsNote), 140)
    },
    commonMistakes: mistakes
  };
}

function normalizeBotEnemySection(input: z.infer<typeof botEnemySectionSchema>): z.infer<typeof botEnemySectionSchema> {
  return {
    threatPattern: clip(cleanLine(input.threatPattern), 240),
    spacingRule: clip(cleanLine(input.spacingRule), 220),
    punishWindow: clip(cleanLine(input.punishWindow), 220),
    commonTrap: clip(cleanLine(input.commonTrap), 220)
  };
}

function fallbackBotEnemyAdvice(playerRole: "adc" | "support"): GeminiBotEnemyAdvice {
  const sharedAdc =
    playerRole === "adc"
      ? {
          threatPattern: "Enemy ADC wins if they keep sustained auto uptime while your wave is thin.",
          spacingRule: "Trade around last-hit moments and stay just outside their free auto range between minion kills.",
          punishWindow: "Step in when enemy ADC uses a damage spell for wave clear or misses their poke cooldown.",
          commonTrap: "Overchasing past your support position and losing return trade tempo."
        }
      : {
          threatPattern: "Enemy ADC is dangerous when they can auto freely while you are disconnected from your ADC.",
          spacingRule: "Hold lateral spacing with your ADC so you can peel or engage without splitting threat zones.",
          punishWindow: "Pressure when enemy ADC uses a key farming cooldown and cannot match immediate retaliation.",
          commonTrap: "Forcing an engage while your ADC is not in range to follow up."
        };
  const sharedSupport =
    playerRole === "adc"
      ? {
          threatPattern: "Enemy support controls the lane through engage or poke cooldown timing.",
          spacingRule: "Track support threat range first, then position for CS only when their key tool is down.",
          punishWindow: "Punish after enemy support misses hook, CC, or primary poke sequence.",
          commonTrap: "Walking up for CS before checking enemy support cooldown and angle."
        }
      : {
          threatPattern: "Enemy support decides many lane starts through vision and cooldown control.",
          spacingRule: "Mirror or shadow enemy support movement so your ADC is never isolated in trade windows.",
          punishWindow: "Take space immediately after enemy support misses engage or uses CC defensively.",
          commonTrap: "Roaming or warding on bad timers that leave your ADC exposed to 2v1 pressure."
        };
  return {
    playerRole,
    vsEnemyAdc: sharedAdc,
    vsEnemySupport: sharedSupport
  };
}

export class GeminiCoachService {
  private readonly apiKeys: string[];

  constructor(private readonly options: GeminiCoachServiceOptions) {
    const keys = [
      ...(options.apiKeys ?? []),
      ...(options.apiKey ? [options.apiKey] : [])
    ]
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    this.apiKeys = [...new Set(keys)];
    if (this.apiKeys.length === 0) {
      throw new Error("GeminiCoachService requires at least one API key.");
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private getNormalizedModel(): string {
    return this.options.model.replace(/^models\//, "");
  }

  private isRetryableKeyFailure(status: number, body: string): boolean {
    if (status === 429) return true;
    if (status === 401 || status === 403) return true;
    if (status === 400 && /(api key not valid|invalid api key|permission denied|key invalid)/i.test(body)) {
      return true;
    }
    return false;
  }

  async getStatus(): Promise<GeminiStatus> {
    const normalizedModel = this.getNormalizedModel();
    const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    let lastStatus: GeminiStatus | null = null;

    for (let idx = 0; idx < this.apiKeys.length; idx += 1) {
      const apiKey = this.apiKeys[idx];
      const modelInfoUrl = `${baseUrl}/models/${normalizedModel}?key=${apiKey}`;
      try {
        const modelResponse = await this.fetchWithTimeout(modelInfoUrl, { method: "GET" }, 7_000);
        if (!modelResponse.ok) {
          const text = await modelResponse.text();
          lastStatus = {
            configured: true,
            model: normalizedModel,
            modelReachable: false,
            generationAvailable: false,
            status: modelResponse.status === 404 ? "model_not_found" : "api_error",
            message: `Model check failed: HTTP ${modelResponse.status}. ${text.slice(0, 300)}`.trim(),
            httpStatus: modelResponse.status
          };
          if (this.isRetryableKeyFailure(modelResponse.status, text) && idx < this.apiKeys.length - 1) continue;
          return lastStatus;
        }

        const generateUrl = `${baseUrl}/models/${normalizedModel}:generateContent?key=${apiKey}`;
        const generationResponse = await this.fetchWithTimeout(
          generateUrl,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: "Return: {\"ok\":true}" }] }],
              generationConfig: { temperature: 0 }
            })
          },
          9_000
        );

        if (generationResponse.ok) {
          return {
            configured: true,
            model: normalizedModel,
            modelReachable: true,
            generationAvailable: true,
            status: "ok",
            message: "Gemini is reachable and generation is available."
          };
        }

        const errorBody = await generationResponse.text();
        const quotaSignal =
          generationResponse.status === 429 &&
          /(quota|resource_exhausted|rate limit|limit: 0)/i.test(errorBody);
        lastStatus = {
          configured: true,
          model: normalizedModel,
          modelReachable: true,
          generationAvailable: false,
          status: quotaSignal ? "quota_exhausted" : "api_error",
          message: `Generation failed: HTTP ${generationResponse.status}. ${errorBody.slice(0, 350)}`.trim(),
          httpStatus: generationResponse.status
        };
        if (this.isRetryableKeyFailure(generationResponse.status, errorBody) && idx < this.apiKeys.length - 1) continue;
        return lastStatus;
      } catch (error) {
        lastStatus = {
          configured: true,
          model: normalizedModel,
          modelReachable: false,
          generationAvailable: false,
          status: "network_error",
          message: error instanceof Error ? error.message : "Unknown network error"
        };
      }
    }

    return (
      lastStatus ?? {
        configured: true,
        model: normalizedModel,
        modelReachable: false,
        generationAvailable: false,
        status: "api_error",
        message: "All configured Gemini keys failed."
      }
    );
  }

  async generateAdvice(input: {
    playerChampion: string;
    enemyChampion: string;
    playerChampionPartner?: string;
    enemyChampionPartner?: string;
    playerRole?: "adc" | "support";
    lane: CoachLane;
    patch: string;
    difficulty: "easy" | "favored" | "even" | "not_favored" | "hard";
    playerTags: string[];
    enemyTags: string[];
    stats?: MatchupStats | null;
    partnerStats?: MatchupStats | null;
  }): Promise<GeminiAdviceResult> {
    const statsBlock = input.stats
      ? `games=${input.stats.games}, winRate=${input.stats.winRate}, goldDiff15=${input.stats.goldDiff15}, pre6KillRate=${input.stats.pre6KillRate}, earlyDeathRate=${input.stats.earlyDeathRate}`
      : "stats unavailable";
    const partnerStatsBlock = input.partnerStats
      ? `games=${input.partnerStats.games}, winRate=${input.partnerStats.winRate}, goldDiff15=${input.partnerStats.goldDiff15}, pre6KillRate=${input.partnerStats.pre6KillRate}, earlyDeathRate=${input.partnerStats.earlyDeathRate}`
      : "partner stats unavailable";
    const prompt = `
You are a League of Legends ${input.lane}-lane coach for Iron-Gold.
Respond ONLY as valid JSON object with keys:
earlyGamePlan, level1to3Rules, allInWindows, runeAdjustments, commonMistakes.

Constraints:
- lane-focused only (no jungle tracking, no teamfight, no late game macro)
- concrete and practical for low-mid elo
- level1to3Rules: 3-5 bullet strings
- allInWindows: 2-5 objects with timing in [level_2, level_3, level_6, first_item, enemy_misstep]
- commonMistakes: exactly 3 strings
- keep tone concise and action-oriented
- if there is no meaningful rune change, return empty strings in runeAdjustments fields

Matchup:
playerChampion=${input.playerChampion}
enemyChampion=${input.enemyChampion}
playerChampionPartner=${input.playerChampionPartner ?? "-"}
enemyChampionPartner=${input.enemyChampionPartner ?? "-"}
playerRole=${input.playerRole ?? "-"}
lane=${input.lane}
patch=${input.patch}
difficulty=${input.difficulty}
playerTags=${input.playerTags.join(",")}
enemyTags=${input.enemyTags.join(",")}
stats=${statsBlock}
partnerStats=${partnerStatsBlock}
`.trim();

    const normalizedModel = this.getNormalizedModel();
    let lastFailure = "Gemini request failed unexpectedly.";
    for (let idx = 0; idx < this.apiKeys.length; idx += 1) {
      const apiKey = this.apiKeys[idx];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${normalizedModel}:generateContent?key=${apiKey}`;
      try {
        const response = await this.fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.35
              }
            })
          },
          10_000
        );

        if (!response.ok) {
          const body = await response.text();
          lastFailure = `Gemini HTTP ${response.status}: ${body.slice(0, 200)}`;
          if (this.isRetryableKeyFailure(response.status, body) && idx < this.apiKeys.length - 1) continue;
          return { advice: null, failureReason: lastFailure };
        }

        let payload: Record<string, unknown>;
        try {
          payload = (await response.json()) as Record<string, unknown>;
        } catch {
          lastFailure = "Gemini returned invalid JSON payload.";
          return { advice: null, failureReason: lastFailure };
        }
        const candidates = (payload.candidates ?? []) as Array<Record<string, unknown>>;
        const text = candidates?.[0]?.content
          ? (((candidates[0].content as Record<string, unknown>).parts ?? []) as Array<Record<string, unknown>>)[0]?.text
          : undefined;

        if (typeof text !== "string" || !text.trim()) {
          lastFailure = "Gemini response had no text content.";
          return { advice: null, failureReason: lastFailure };
        }

        const jsonText = extractJsonObject(text);
        const parsedJson = tryLenientParse(jsonText);
        const normalized =
          parsedJson && geminiAdviceSchema.safeParse(parsedJson).success
            ? normalizeAdvice((parsedJson as GeminiAdviceRaw))
            : normalizeFromPlainText(text);
        if (!normalized) {
          lastFailure = "Gemini JSON did not match expected coaching schema.";
          return { advice: null, failureReason: lastFailure };
        }

        const shouldGenerateBotAdvice =
          input.lane === "bot" &&
          Boolean(input.playerRole) &&
          Boolean(input.playerChampionPartner) &&
          Boolean(input.enemyChampionPartner);
        if (!shouldGenerateBotAdvice) {
          return { advice: normalized };
        }

        const botPrompt = `
You are a League of Legends botlane coach for Iron-Gold.
Perspective: playerRole=${input.playerRole}.
Allied duo: ${input.playerChampion} + ${input.playerChampionPartner}
Enemy duo: ${input.enemyChampion} + ${input.enemyChampionPartner}

Return ONLY valid JSON with keys:
vsEnemyAdc, vsEnemySupport

Each key is an object with exactly:
- threatPattern
- spacingRule
- punishWindow
- commonTrap

Write role-specific advice from the player's perspective.
Keep each value practical and concise (1 sentence each).
`.trim();
        const botResponse = await this.fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: botPrompt }] }],
              generationConfig: {
                temperature: 0.2
              }
            })
          },
          10_000
        );
        if (!botResponse.ok) {
          return {
            advice: normalized,
            botlaneAdvice: fallbackBotEnemyAdvice(input.playerRole as "adc" | "support")
          };
        }
        const botPayload = (await botResponse.json()) as Record<string, unknown>;
        const botCandidates = (botPayload.candidates ?? []) as Array<Record<string, unknown>>;
        const botText = botCandidates?.[0]?.content
          ? (((botCandidates[0].content as Record<string, unknown>).parts ?? []) as Array<Record<string, unknown>>)[0]
              ?.text
          : undefined;
        if (typeof botText !== "string" || !botText.trim()) {
          return {
            advice: normalized,
            botlaneAdvice: fallbackBotEnemyAdvice(input.playerRole as "adc" | "support")
          };
        }
        const botJsonText = extractJsonObject(botText);
        const botParsed = tryLenientParse(botJsonText);
        const parsedBotAdvice = geminiBotEnemyAdviceSchema.safeParse(botParsed);
        if (!parsedBotAdvice.success) {
          return {
            advice: normalized,
            botlaneAdvice: fallbackBotEnemyAdvice(input.playerRole as "adc" | "support")
          };
        }
        return {
          advice: normalized,
          botlaneAdvice: {
            playerRole: input.playerRole as "adc" | "support",
            vsEnemyAdc: normalizeBotEnemySection(parsedBotAdvice.data.vsEnemyAdc),
            vsEnemySupport: normalizeBotEnemySection(parsedBotAdvice.data.vsEnemySupport)
          }
        };
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : "Gemini request failed unexpectedly.";
      }
    }

    return {
      advice: null,
      failureReason: `All configured Gemini keys failed. Last error: ${lastFailure}`
    };
  }
}
