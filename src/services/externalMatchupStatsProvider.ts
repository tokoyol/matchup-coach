import { championKey, type SupportedLane } from "../data/champions.js";
import type { MatchupStats } from "../types/stats.js";

export interface ExternalMatchupLookupInput {
  lane: SupportedLane;
  patch: string;
  playerChampion: string;
  enemyChampion: string;
}

export interface ExternalMatchupLookupResult {
  provider: string;
  stats: MatchupStats;
}

export interface ExternalMatchupStatsProvider {
  getMatchupStats(input: ExternalMatchupLookupInput): Promise<ExternalMatchupLookupResult | null>;
}

function mapLaneToLolalytics(lane: SupportedLane): string {
  if (lane === "mid") return "middle";
  if (lane === "adc") return "bottom";
  return lane;
}

function normalizeWinRate(raw: number): number {
  if (!Number.isFinite(raw)) return 0.5;
  return raw > 1 ? Number((raw / 100).toFixed(3)) : Number(raw.toFixed(3));
}

function normalizePatch(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length >= 4 && /^\d{2}\.\d{1,2}$/.test(trimmed)) return trimmed.slice(1);
  return trimmed;
}

function parseFromRenderedHtml(html: string): { games: number; winRate: number; goldDiff15: number } | null {
  const fromSentence = html.match(
    /wins against[\s\S]{0,220}?([0-9]+(?:\.[0-9]+)?)%\s+of the time[\s\S]{0,220}?based on\s+([0-9,]+)\s+matches/i
  );
  if (fromSentence) {
    const winRate = Number(fromSentence[1]);
    const games = Number(fromSentence[2].replace(/,/g, ""));
    if (Number.isFinite(winRate) && Number.isFinite(games) && games > 0) {
      return {
        games: Math.floor(games),
        winRate: normalizeWinRate(winRate),
        goldDiff15: 0
      };
    }
  }

  const fromCard = html.match(
    /([0-9]+(?:\.[0-9]+)?)<!---->%\s*Win Rate[\s\S]{0,220}?([0-9,]+)\s+Games/i
  );
  if (fromCard) {
    const winRate = Number(fromCard[1]);
    const games = Number(fromCard[2].replace(/,/g, ""));
    if (Number.isFinite(winRate) && Number.isFinite(games) && games > 0) {
      return {
        games: Math.floor(games),
        winRate: normalizeWinRate(winRate),
        goldDiff15: 0
      };
    }
  }

  return null;
}

type Primitive = string | number | boolean | null | undefined;

function scanForBestStatsNode(value: unknown): { games: number; winRate: number; goldDiff15: number } | null {
  let best: { games: number; winRate: number; goldDiff15: number } | null = null;

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const record = node as Record<string, Primitive | unknown>;
    const entries = Object.entries(record);

    let games: number | null = null;
    let winRate: number | null = null;
    let goldDiff15 = 0;

    for (const [key, raw] of entries) {
      if (typeof raw !== "number") continue;
      if (games === null && /(games|sample|matchcount|n_games|nGames)/i.test(key)) {
        games = Math.max(0, Math.floor(raw));
      }
      if (winRate === null && /(winrate|win_rate|wr|winRate)/i.test(key)) {
        winRate = normalizeWinRate(raw);
      }
      if (/(gd15|golddiff15|gold_diff_15|goldDiffAt15|avgGoldDiffAt15)/i.test(key)) {
        goldDiff15 = Math.round(raw);
      }
    }

    if (games !== null && games > 0 && winRate !== null) {
      if (!best || games > best.games) {
        best = { games, winRate, goldDiff15 };
      }
    }

    for (const [, child] of entries) {
      walk(child);
    }
  };

  walk(value);
  return best;
}

export class LolalyticsScrapeProvider implements ExternalMatchupStatsProvider {
  private readonly cache = new Map<string, { result: ExternalMatchupLookupResult; expiresAt: number }>();

  constructor(
    private readonly timeoutMs: number = 3500,
    private readonly cacheTtlMs: number = 30 * 60 * 1000
  ) {}

  async getMatchupStats(input: ExternalMatchupLookupInput): Promise<ExternalMatchupLookupResult | null> {
    const lane = mapLaneToLolalytics(input.lane);
    const patch = normalizePatch(input.patch);
    const player = championKey(input.playerChampion);
    const enemy = championKey(input.enemyChampion);
    if (!player || !enemy) return null;
    const cacheKey = `${input.patch}:${input.lane}:${player}:${enemy}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    const urlWithPatch = `https://lolalytics.com/lol/${player}/vs/${enemy}/build/?lane=${lane}${
      patch ? `&patch=${encodeURIComponent(patch)}` : ""
    }`;
    const urlWithoutPatch = `https://lolalytics.com/lol/${player}/vs/${enemy}/build/?lane=${lane}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response = await fetch(urlWithPatch, {
        headers: {
          "user-agent": "matchup-coach/0.1 (+stats-fetch)"
        },
        signal: controller.signal
      });
      if (!response.ok && patch) {
        response = await fetch(urlWithoutPatch, {
          headers: {
            "user-agent": "matchup-coach/0.1 (+stats-fetch)"
          },
          signal: controller.signal
        });
      }
      if (!response.ok) return null;
      const html = await response.text();

      const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
      if (!nextDataMatch?.[1]) {
        const parsedHtml = parseFromRenderedHtml(html);
        if (!parsedHtml) return null;
        const result = {
          provider: "lolalytics",
          stats: {
            patch: input.patch,
            games: parsedHtml.games,
            winRate: parsedHtml.winRate,
            goldDiff15: parsedHtml.goldDiff15,
            pre6KillRate: 0,
            earlyDeathRate: 0,
            runeUsage: [],
            firstItemUsage: [],
            computedAt: new Date().toISOString()
          }
        };
        this.cache.set(cacheKey, { result, expiresAt: Date.now() + this.cacheTtlMs });
        return result;
      }

      const parsed = JSON.parse(nextDataMatch[1]) as unknown;
      const best = scanForBestStatsNode(parsed);
      if (!best || best.games <= 0) return null;

      const result = {
        provider: "lolalytics",
        stats: {
          patch: input.patch,
          games: best.games,
          winRate: best.winRate,
          goldDiff15: best.goldDiff15,
          pre6KillRate: 0,
          earlyDeathRate: 0,
          runeUsage: [],
          firstItemUsage: [],
          computedAt: new Date().toISOString()
        }
      };
      this.cache.set(cacheKey, { result, expiresAt: Date.now() + this.cacheTtlMs });
      return result;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
