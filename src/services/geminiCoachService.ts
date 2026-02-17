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

interface GeminiCoachServiceOptions {
  apiKey: string;
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

export class GeminiCoachService {
  constructor(private readonly options: GeminiCoachServiceOptions) {}

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

  async getStatus(): Promise<GeminiStatus> {
    const normalizedModel = this.getNormalizedModel();
    const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    const modelInfoUrl = `${baseUrl}/models/${normalizedModel}?key=${this.options.apiKey}`;

    try {
      const modelResponse = await this.fetchWithTimeout(modelInfoUrl, { method: "GET" }, 7_000);
      if (!modelResponse.ok) {
        const text = await modelResponse.text();
        return {
          configured: true,
          model: normalizedModel,
          modelReachable: false,
          generationAvailable: false,
          status: modelResponse.status === 404 ? "model_not_found" : "api_error",
          message: `Model check failed: HTTP ${modelResponse.status}. ${text.slice(0, 300)}`.trim(),
          httpStatus: modelResponse.status
        };
      }

      const generateUrl = `${baseUrl}/models/${normalizedModel}:generateContent?key=${this.options.apiKey}`;
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

      return {
        configured: true,
        model: normalizedModel,
        modelReachable: true,
        generationAvailable: false,
        status: quotaSignal ? "quota_exhausted" : "api_error",
        message: `Generation failed: HTTP ${generationResponse.status}. ${errorBody.slice(0, 350)}`.trim(),
        httpStatus: generationResponse.status
      };
    } catch (error) {
      return {
        configured: true,
        model: normalizedModel,
        modelReachable: false,
        generationAvailable: false,
        status: "network_error",
        message: error instanceof Error ? error.message : "Unknown network error"
      };
    }
  }

  async generateAdvice(input: {
    playerChampion: string;
    enemyChampion: string;
    playerChampionPartner?: string;
    enemyChampionPartner?: string;
    lane: CoachLane;
    patch: string;
    difficulty: "easy" | "even" | "hard";
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
lane=${input.lane}
patch=${input.patch}
difficulty=${input.difficulty}
playerTags=${input.playerTags.join(",")}
enemyTags=${input.enemyTags.join(",")}
stats=${statsBlock}
partnerStats=${partnerStatsBlock}
`.trim();

    const normalizedModel = this.getNormalizedModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${normalizedModel}:generateContent?key=${this.options.apiKey}`;
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
        return {
          advice: null,
          failureReason: `Gemini HTTP ${response.status}: ${body.slice(0, 200)}`
        };
      }

      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {
        return { advice: null, failureReason: "Gemini returned invalid JSON payload." };
      }
      const candidates = (payload.candidates ?? []) as Array<Record<string, unknown>>;
      const text = candidates?.[0]?.content
        ? (((candidates[0].content as Record<string, unknown>).parts ?? []) as Array<Record<string, unknown>>)[0]?.text
        : undefined;

      if (typeof text !== "string" || !text.trim()) {
        return { advice: null, failureReason: "Gemini response had no text content." };
      }

      const jsonText = extractJsonObject(text);
      const parsedJson = tryLenientParse(jsonText);
      if (!parsedJson) {
        const normalized = normalizeFromPlainText(text);
        if (normalized) return { advice: normalized };
        return { advice: null, failureReason: "Gemini text was not parseable JSON." };
      }
      const parsedAdvice = geminiAdviceSchema.safeParse(parsedJson);
      if (!parsedAdvice.success) {
        const normalized = normalizeFromPlainText(text);
        if (normalized) {
          return { advice: normalized };
        }
        return { advice: null, failureReason: "Gemini JSON did not match expected coaching schema." };
      }
      return { advice: normalizeAdvice(parsedAdvice.data) };
    } catch (error) {
      return {
        advice: null,
        failureReason: error instanceof Error ? error.message : "Gemini request failed unexpectedly."
      };
    }
  }
}
