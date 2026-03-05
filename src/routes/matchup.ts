import { Router } from "express";
import {
  SUPPORTED_LANES,
  SUPPORTED_TOP_CHAMPIONS,
  championKey,
  normalizeChampionName,
  normalizeCoachLane,
  normalizeLane
} from "../data/champions.js";
import { coachMatchupRequestSchema, coachMatchupResponseSchema } from "../schemas/matchup.js";
import { generateMatchupCoaching } from "../services/coachService.js";
import { ChampionFactsService } from "../services/championFactsService.js";
import type { ExternalMatchupStatsProvider } from "../services/externalMatchupStatsProvider.js";
import { GeminiCoachService } from "../services/geminiCoachService.js";
import type { MatchupStatsStore } from "../services/matchupStatsStore.js";
import type { MatchupStats } from "../types/stats.js";
import { z } from "zod";

const feedbackRequestSchema = z.object({
  patch: z.string().min(1),
  lane: z.string().min(1),
  playerChampion: z.string().min(1),
  enemyChampion: z.string().min(1),
  rating: z.enum(["good", "bad"]),
  comment: z.string().optional()
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Aggregate 4 bot dimension lookups (adc vs adc, adc vs support, support vs adc, support vs support) into one duo-vs-duo stats. */
function aggregateBotDuoStats(
  patch: string,
  results: [MatchupStats | null, MatchupStats | null, MatchupStats | null, MatchupStats | null]
): MatchupStats | null {
  const [adcVsAdc, adcVsSupport, supportVsAdc, supportVsSupport] = results;
  const rows = [adcVsAdc, adcVsSupport, supportVsAdc, supportVsSupport].filter(
    (r): r is MatchupStats => r != null && r.games > 0
  );
  if (rows.length === 0) return null;
  const totalGames = rows.reduce((sum, r) => sum + r.games, 0);
  if (totalGames <= 0) return null;
  const winRateSum = rows.reduce((sum, r) => sum + r.winRate * r.games, 0);
  const winRate = Number((winRateSum / totalGames).toFixed(3));
  const best = rows.reduce((a, b) => (a.games >= b.games ? a : b));
  return {
    patch,
    games: totalGames,
    winRate,
    goldDiff15: best.goldDiff15,
    pre6KillRate: best.pre6KillRate,
    earlyDeathRate: best.earlyDeathRate,
    runeUsage: best.runeUsage,
    firstItemUsage: best.firstItemUsage,
    computedAt: best.computedAt
  };
}

function clampWarning(message: string): string {
  const trimmed = message.trim();
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117).trim()}...`;
}

function getPreviousPatch(patch: string): string | null {
  const match = /^(\d{2})\.(\d{1,2})$/.exec(patch.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  if (minor <= 0) return null;
  return `${String(major).padStart(2, "0")}.${minor - 1}`;
}

function invertMatchupPerspective(stats: MatchupStats): MatchupStats {
  const clampRate = (value: number): number => Math.max(0, Math.min(1, value));
  return {
    ...stats,
    winRate: Number((1 - stats.winRate).toFixed(3)),
    goldDiff15: Math.round(-stats.goldDiff15),
    pre6KillRate: Number(clampRate(stats.earlyDeathRate).toFixed(3)),
    earlyDeathRate: Number(clampRate(stats.pre6KillRate).toFixed(3)),
    // Rune/item usage in mirrored rows belong to the opposite champion perspective.
    runeUsage: [],
    firstItemUsage: []
  };
}

async function getStatsWithMirroredFallback(
  repository: MatchupStatsStore,
  patch: string,
  lane: "top" | "jungle" | "mid" | "adc" | "support",
  playerChampion: string,
  enemyChampion: string
): Promise<{ stats: MatchupStats | null; mirrored: boolean }> {
  const direct = await repository.get(patch, lane, playerChampion, enemyChampion);
  if (direct) return { stats: direct, mirrored: false };
  const reversed = await repository.get(patch, lane, enemyChampion, playerChampion);
  if (!reversed) return { stats: null, mirrored: false };
  return { stats: invertMatchupPerspective(reversed), mirrored: true };
}

const CHAMPION_LOCALIZATION_CACHE_TTL_MS = 1000 * 60 * 60 * 6;

let cachedJaChampionLocalization: {
  fetchedAt: number;
  patch: string;
  names: Record<string, string>;
} | null = null;

interface DDragonChampionPayload {
  data: Record<
    string,
    {
      id: string;
      name: string;
    }
  >;
}

async function fetchJaChampionLocalization(): Promise<{
  patch: string;
  names: Record<string, string>;
}> {
  const versionsResponse = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  if (!versionsResponse.ok) {
    throw new Error(`Failed to fetch Data Dragon versions (HTTP ${versionsResponse.status}).`);
  }
  const versions = (await versionsResponse.json()) as string[];
  const patch = versions[0];
  if (!patch) {
    throw new Error("Data Dragon returned an empty version list.");
  }

  const [enResponse, jaResponse] = await Promise.all([
    fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/ja_JP/champion.json`)
  ]);
  if (!enResponse.ok || !jaResponse.ok) {
    throw new Error(`Failed to fetch champion localization payloads (${enResponse.status}/${jaResponse.status}).`);
  }

  const [enData, jaData] = (await Promise.all([
    enResponse.json() as Promise<DDragonChampionPayload>,
    jaResponse.json() as Promise<DDragonChampionPayload>
  ])) as [DDragonChampionPayload, DDragonChampionPayload];

  const names: Record<string, string> = {};
  Object.values(enData.data).forEach((enChampion) => {
    const jaChampion = jaData.data[enChampion.id];
    if (!jaChampion?.name) return;
    names[championKey(enChampion.name)] = jaChampion.name;
    names[championKey(enChampion.id)] = jaChampion.name;
  });

  return { patch, names };
}

interface CreateMatchupRouterOptions {
  currentPatch: string;
  minSampleGames?: number;
  statsRepository?: MatchupStatsStore;
  externalStatsProvider?: ExternalMatchupStatsProvider;
  geminiCoachService?: GeminiCoachService;
  championFactsService?: ChampionFactsService;
  dbClient?: { type: "postgres"; pool: import("pg").Pool } | { type: "sqlite"; db: import("sqlite").Database };
}

export function createMatchupRouter(options: CreateMatchupRouterOptions): Router {
  const {
    currentPatch,
    minSampleGames,
    statsRepository,
    externalStatsProvider,
    geminiCoachService,
    championFactsService,
    dbClient
  } = options;
  const requiredSampleGames = Math.max(1, Math.floor(minSampleGames ?? 10));
  const router = Router();

  router.get("/config", (_req, res) => {
    res.json({
      patch: currentPatch
    });
  });

  router.get("/champion-localization", async (req, res) => {
    const language = String(req.query.language ?? "en").trim().toLowerCase();
    if (language !== "ja") {
      return res.json({
        language: "en",
        patch: currentPatch,
        names: {}
      });
    }

    if (championFactsService) {
      try {
        const metadata = await championFactsService.getFactsByKey();
        const names: Record<string, string> = {};
        Object.entries(metadata.factsByKey).forEach(([key, facts]) => {
          names[key] = facts.displayNameJa;
        });
        return res.json({
          language: "ja",
          patch: metadata.patch,
          names
        });
      } catch (error) {
        return res.status(200).json({
          language: "ja",
          patch: currentPatch,
          names: {},
          warning: error instanceof Error ? error.message : "Failed to load champion localization."
        });
      }
    }

    const now = Date.now();
    if (cachedJaChampionLocalization && now - cachedJaChampionLocalization.fetchedAt < CHAMPION_LOCALIZATION_CACHE_TTL_MS) {
      return res.json({
        language: "ja",
        patch: cachedJaChampionLocalization.patch,
        names: cachedJaChampionLocalization.names
      });
    }

    try {
      const localization = await fetchJaChampionLocalization();
      cachedJaChampionLocalization = {
        fetchedAt: now,
        patch: localization.patch,
        names: localization.names
      };
      return res.json({
        language: "ja",
        patch: localization.patch,
        names: localization.names
      });
    } catch (error) {
      return res.status(200).json({
        language: "ja",
        patch: currentPatch,
        names: {},
        warning: error instanceof Error ? error.message : "Failed to load champion localization."
      });
    }
  });

  router.get("/champion-metadata", async (_req, res) => {
    if (!championFactsService) {
      return res.status(503).json({
        error: "Champion facts service unavailable."
      });
    }
    try {
      const metadata = await championFactsService.getFactsByKey();
      const championsByKey = Object.fromEntries(
        Object.entries(metadata.factsByKey).map(([key, facts]) => [
          key,
          {
            championId: facts.championId,
            canonicalName: facts.canonicalName,
            displayNameEn: facts.displayNameEn,
            displayNameJa: facts.displayNameJa
          }
        ])
      );
      return res.json({
        patch: metadata.patch,
        championsByKey
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to load champion metadata.",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  router.get("/champions", async (req, res) => {
    try {
      const rawLane = String(req.query.lane ?? "top").trim().toLowerCase();
      const isBotAggregate = rawLane === "bot";
      const dataLane = normalizeLane(rawLane);
      const lane = isBotAggregate ? "bot" : dataLane;
      let sourcePatch = currentPatch;
      let resolvedDynamicChampions: string[] = [];
      let checkedPatch = currentPatch;

      for (let i = 0; i < 4; i++) {
        const dynamicChampions = isBotAggregate
          ? statsRepository
            ? [
              ...(await statsRepository.listChampionsByLane(checkedPatch, "adc", 400)),
              ...(await statsRepository.listChampionsByLane(checkedPatch, "support", 400))
            ]
            : []
          : statsRepository
            ? await statsRepository.listChampionsByLane(checkedPatch, dataLane, 400)
            : [];

        if (dynamicChampions.length > 0) {
          resolvedDynamicChampions = dynamicChampions;
          sourcePatch = checkedPatch;
          break;
        }

        const prev = getPreviousPatch(checkedPatch);
        if (!prev) break;
        checkedPatch = prev;
      }
      const champions =
        lane === "top"
          ? [...new Set([...SUPPORTED_TOP_CHAMPIONS, ...resolvedDynamicChampions])]
          : [...new Set(resolvedDynamicChampions)];
      const normalizedChampions = [...new Set(champions.map((champion) => normalizeChampionName(champion)))];
      return res.json({
        lane,
        patch: sourcePatch,
        champions: normalizedChampions.sort((a, b) => a.localeCompare(b))
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to load champions.",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  router.post("/coach/matchup", async (req, res) => {
    const parseInput = coachMatchupRequestSchema.safeParse({
      ...req.body,
      playerChampion: normalizeChampionName(req.body?.playerChampion ?? ""),
      enemyChampion: normalizeChampionName(req.body?.enemyChampion ?? ""),
      playerRole: typeof req.body?.playerRole === "string" ? String(req.body.playerRole).trim().toLowerCase() : undefined,
      playerChampionPartner: req.body?.playerChampionPartner
        ? normalizeChampionName(req.body.playerChampionPartner)
        : undefined,
      enemyChampionPartner: req.body?.enemyChampionPartner
        ? normalizeChampionName(req.body.enemyChampionPartner)
        : undefined
    });

    if (!parseInput.success) {
      return res.status(400).json({
        error: "Invalid request body.",
        details: parseInput.error.flatten()
      });
    }

    try {
      const language = parseInput.data.language === "ja" ? "ja" : "en";
      const lane = normalizeCoachLane(parseInput.data.lane);
      const requestedPatch = parseInput.data.patch ?? currentPatch;
      const previousPatch = getPreviousPatch(requestedPatch);
      let resolvedPatch = requestedPatch;
      let usedPreviousPatchFallback = false;
      let usedMirroredFallback = false;
      let primaryStats: MatchupStats | null = null;
      let partnerStats: MatchupStats | null = null;
      let primaryStatsGames = 0;
      let partnerStatsGames = 0;
      let externalPrimaryStats: MatchupStats | null = null;
      let externalPartnerStats: MatchupStats | null = null;
      let externalSourceMeta:
        | {
          provider: string;
          status: "success" | "cache_hit" | "http_error" | "timeout" | "network_error" | "parse_miss";
          failureReason?: string;
          httpStatus?: number;
        }
        | null = null;
      let usedExternalProvider: string | null = null;
      const playerRole = parseInput.data.playerRole ?? "adc";
      const playerAdc =
        lane === "bot"
          ? (playerRole === "adc" ? parseInput.data.playerChampion : parseInput.data.playerChampionPartner!)
          : "";
      const playerSupport =
        lane === "bot"
          ? (playerRole === "adc" ? parseInput.data.playerChampionPartner! : parseInput.data.playerChampion)
          : "";
      const enemyAdc = lane === "bot" ? parseInput.data.enemyChampion : "";
      const enemySupport = lane === "bot" ? (parseInput.data.enemyChampionPartner ?? "") : "";
      const botlaneContexts =
        lane === "bot" && playerAdc && playerSupport && enemyAdc && parseInput.data.playerRole
          ? {
            playerRole: parseInput.data.playerRole,
            allyAdc: playerAdc,
            allySupport: playerSupport,
            enemyAdc,
            enemySupport
          }
          : undefined;
      let factsWarning = "";
      let dbWarning = "";
      let championFacts:
        | {
          playerFacts: Awaited<ReturnType<ChampionFactsService["getChampionFacts"]>>;
          enemyFacts: Awaited<ReturnType<ChampionFactsService["getChampionFacts"]>>;
          playerPartnerFacts: Awaited<ReturnType<ChampionFactsService["getChampionFacts"]>>;
          enemyPartnerFacts: Awaited<ReturnType<ChampionFactsService["getChampionFacts"]>>;
        }
        | undefined;
      if (championFactsService) {
        try {
          const [playerFacts, enemyFacts, playerPartnerFacts, enemyPartnerFacts] = await Promise.all([
            championFactsService.getChampionFacts(parseInput.data.playerChampion),
            championFactsService.getChampionFacts(parseInput.data.enemyChampion),
            championFactsService.getChampionFacts(parseInput.data.playerChampionPartner ?? ""),
            championFactsService.getChampionFacts(parseInput.data.enemyChampionPartner ?? "")
          ]);
          championFacts = {
            playerFacts,
            enemyFacts,
            playerPartnerFacts,
            enemyPartnerFacts
          };
        } catch (error) {
          factsWarning = error instanceof Error ? error.message : "Champion facts lookup failed.";
        }
      }
      // Bot: 4 lookups (adc vs adc, adc vs support, support vs adc, support vs support) aggregated to duo vs duo. Non-bot: single lookup.
      if (statsRepository) {
        try {
          if (lane === "bot" && playerAdc && playerSupport && enemyAdc) {
            const [adcVsAdc, adcVsSupport, supportVsAdc, supportVsSupport] = await Promise.all([
              getStatsWithMirroredFallback(statsRepository, requestedPatch, "adc", playerAdc, enemyAdc),
              getStatsWithMirroredFallback(statsRepository, requestedPatch, "adc", playerAdc, enemySupport),
              getStatsWithMirroredFallback(statsRepository, requestedPatch, "support", playerSupport, enemyAdc),
              getStatsWithMirroredFallback(statsRepository, requestedPatch, "support", playerSupport, enemySupport)
            ]);
            usedMirroredFallback =
              adcVsAdc.mirrored || adcVsSupport.mirrored || supportVsAdc.mirrored || supportVsSupport.mirrored;
            primaryStats = aggregateBotDuoStats(requestedPatch, [
              adcVsAdc.stats,
              adcVsSupport.stats,
              supportVsAdc.stats,
              supportVsSupport.stats
            ]);
            primaryStatsGames = primaryStats?.games ?? 0;
            partnerStats = null;
            partnerStatsGames = 0;
          } else if (lane !== "bot") {
            const laneLookup = await getStatsWithMirroredFallback(
              statsRepository,
              requestedPatch,
              lane,
              parseInput.data.playerChampion,
              parseInput.data.enemyChampion
            );
            primaryStats = laneLookup.stats;
            primaryStatsGames = laneLookup.stats?.games ?? 0;
            usedMirroredFallback = laneLookup.mirrored;
          }
        } catch (dbError) {
          console.error("[matchup] Database stats lookup failed:", dbError);
          dbWarning = "Database lookup failed; showing coaching without cached stats.";
        }
      }
      let checkedPatchForStats = requestedPatch;
      for (let i = 0; i < 4; i++) {
        if (!statsRepository) break;
        const enoughGames =
          lane === "bot"
            ? primaryStatsGames >= requiredSampleGames
            : primaryStatsGames + partnerStatsGames >= requiredSampleGames;
        if (enoughGames) break;

        // On i=0, we already did the lookup above, so skip to i=1 if i=0 is insufficient.
        if (i > 0) {
          const prev = getPreviousPatch(checkedPatchForStats);
          if (!prev) break;
          checkedPatchForStats = prev;

          if (lane === "bot" && playerAdc && playerSupport && enemyAdc) {
            const [adcVsAdc, adcVsSupport, supportVsAdc, supportVsSupport] = await Promise.all([
              getStatsWithMirroredFallback(statsRepository, checkedPatchForStats, "adc", playerAdc, enemyAdc),
              getStatsWithMirroredFallback(statsRepository, checkedPatchForStats, "adc", playerAdc, enemySupport),
              getStatsWithMirroredFallback(statsRepository, checkedPatchForStats, "support", playerSupport, enemyAdc),
              getStatsWithMirroredFallback(statsRepository, checkedPatchForStats, "support", playerSupport, enemySupport)
            ]);
            const aggregated = aggregateBotDuoStats(checkedPatchForStats, [
              adcVsAdc.stats,
              adcVsSupport.stats,
              supportVsAdc.stats,
              supportVsSupport.stats
            ]);
            const aggGames = aggregated?.games ?? 0;
            if (aggGames > primaryStatsGames) {
              primaryStats = aggregated;
              primaryStatsGames = aggGames;
              resolvedPatch = checkedPatchForStats;
              usedPreviousPatchFallback = true;
              usedMirroredFallback =
                adcVsAdc.mirrored || adcVsSupport.mirrored || supportVsAdc.mirrored || supportVsSupport.mirrored;
            }
          } else if (lane !== "bot") {
            const laneLookup = await getStatsWithMirroredFallback(
              statsRepository,
              checkedPatchForStats,
              lane,
              parseInput.data.playerChampion,
              parseInput.data.enemyChampion
            );
            if ((laneLookup.stats?.games ?? 0) > primaryStatsGames) {
              primaryStats = laneLookup.stats;
              primaryStatsGames = laneLookup.stats?.games ?? 0;
              resolvedPatch = checkedPatchForStats;
              usedPreviousPatchFallback = true;
              usedMirroredFallback = laneLookup.mirrored;
            }
          }
        }
      }
      const riotSampleSize = 0;
      if (externalStatsProvider) {
        try {
          if (lane === "bot" && playerAdc && playerSupport && enemyAdc) {
            const [extAdcVsAdc, extAdcVsSupport, extSupportVsAdc, extSupportVsSupport] = await Promise.all([
              withTimeout(
                externalStatsProvider.getMatchupStats({
                  lane: "adc",
                  patch: requestedPatch,
                  playerChampion: playerAdc,
                  enemyChampion: enemyAdc
                }),
                4_000,
                "External matchup source timed out."
              ),
              withTimeout(
                externalStatsProvider.getMatchupStats({
                  lane: "adc",
                  patch: requestedPatch,
                  playerChampion: playerAdc,
                  enemyChampion: enemySupport
                }),
                4_000,
                "External matchup source timed out."
              ),
              withTimeout(
                externalStatsProvider.getMatchupStats({
                  lane: "support",
                  patch: requestedPatch,
                  playerChampion: playerSupport,
                  enemyChampion: enemyAdc
                }),
                4_000,
                "External matchup source timed out."
              ),
              withTimeout(
                externalStatsProvider.getMatchupStats({
                  lane: "support",
                  patch: requestedPatch,
                  playerChampion: playerSupport,
                  enemyChampion: enemySupport
                }),
                4_000,
                "External matchup source timed out."
              )
            ]);
            const extStats = [
              extAdcVsAdc.result?.stats ?? null,
              extAdcVsSupport.result?.stats ?? null,
              extSupportVsAdc.result?.stats ?? null,
              extSupportVsSupport.result?.stats ?? null
            ] as [MatchupStats | null, MatchupStats | null, MatchupStats | null, MatchupStats | null];
            const extAggregated = aggregateBotDuoStats(requestedPatch, extStats);
            const extGames = extAggregated?.games ?? 0;
            if (extAggregated && extGames > primaryStatsGames) {
              externalPrimaryStats = extAggregated;
              primaryStats = extAggregated;
              primaryStatsGames = extGames;
              usedExternalProvider = extAdcVsAdc.provider;
            }
            const preferredOutcome =
              [extAdcVsAdc, extAdcVsSupport, extSupportVsAdc, extSupportVsSupport].find(
                (o) => o.status !== "success" && o.status !== "cache_hit"
              ) ?? extAdcVsAdc;
            externalSourceMeta = {
              provider: preferredOutcome.provider,
              status: preferredOutcome.status,
              failureReason: preferredOutcome.failureReason,
              httpStatus: preferredOutcome.httpStatus
            };
          } else if (lane !== "bot") {
            const externalStats = await withTimeout(
              externalStatsProvider.getMatchupStats({
                lane,
                patch: requestedPatch,
                playerChampion: parseInput.data.playerChampion,
                enemyChampion: parseInput.data.enemyChampion
              }),
              4_000,
              "External matchup source timed out."
            );
            externalSourceMeta = {
              provider: externalStats.provider,
              status: externalStats.status,
              failureReason: externalStats.failureReason,
              httpStatus: externalStats.httpStatus
            };
            const externalResult = externalStats.result;
            if (externalResult?.stats && primaryStatsGames < externalResult.stats.games) {
              externalPrimaryStats = externalResult.stats;
              primaryStats = externalResult.stats;
              primaryStatsGames = externalResult.stats.games;
              usedExternalProvider = externalResult.provider;
            }
          }
        } catch (error) {
          externalSourceMeta = {
            provider: "lolalytics",
            status: "timeout",
            failureReason: error instanceof Error ? error.message : "External source lookup failed."
          };
        }
      }

      const currentSampleSize =
        lane === "bot" ? (primaryStats?.games ?? 0) : (primaryStats?.games ?? 0) + (partnerStats?.games ?? 0);
      const externalSampleSize =
        lane === "bot"
          ? (externalPrimaryStats?.games ?? 0)
          : (externalPrimaryStats?.games ?? 0) + (externalPartnerStats?.games ?? 0);
      const hasEnoughSample = currentSampleSize >= requiredSampleGames;
      const statsForCoaching = lane === "bot" ? primaryStats : primaryStats;
      const partnerStatsForCoaching = lane === "bot" ? null : partnerStats;

      const coaching = await generateMatchupCoaching(
        {
          ...parseInput.data,
          patch: resolvedPatch,
          lane
        },
        currentPatch,
        statsForCoaching,
        partnerStatsForCoaching,
        hasEnoughSample ? geminiCoachService : undefined,
        {
          sampleTarget: requiredSampleGames,
          providerSamples: {
            riotGames: riotSampleSize,
            externalGames: externalSampleSize,
            effectiveGames: currentSampleSize
          },
          externalSource: externalSourceMeta,
          botlaneContexts,
          championFacts
        }
      );
      if (usedExternalProvider) {
        coaching.meta.warnings = [
          clampWarning(
            language === "ja"
              ? `${usedExternalProvider}のマッチアップ統計を使用しています。`
              : `Using matchup stats from ${usedExternalProvider}.`
          ),
          ...coaching.meta.warnings
        ];
      } else if (externalSourceMeta && externalSourceMeta.status !== "success" && externalSourceMeta.status !== "cache_hit") {
        coaching.meta.warnings = [
          clampWarning(
            language === "ja"
              ? `外部ソースを利用できません (${externalSourceMeta.status})${externalSourceMeta.failureReason ? `: ${externalSourceMeta.failureReason}` : ""}`
              : `External source unavailable (${externalSourceMeta.status})${externalSourceMeta.failureReason ? `: ${externalSourceMeta.failureReason}` : ""}`
          ),
          ...coaching.meta.warnings
        ];
      }
      if (usedPreviousPatchFallback) {
        coaching.meta.warnings = [
          clampWarning(
            language === "ja"
              ? `現在パッチ(${requestedPatch})のサンプルが不足しているため、前パッチ(${resolvedPatch})のデータを使用しています。`
              : `Current patch (${requestedPatch}) has limited samples; using previous patch (${resolvedPatch}) data.`
          ),
          ...coaching.meta.warnings
        ];
      }
      if (usedMirroredFallback) {
        coaching.meta.warnings = [
          clampWarning(
            language === "ja"
              ? "対向視点のマッチアップ統計を反転して使用しています（勝率/序盤指標を補正）。"
              : "Using mirrored matchup stats (enemy-vs-player row inverted for winrate/early metrics)."
          ),
          ...coaching.meta.warnings
        ];
      }
      if (factsWarning) {
        coaching.meta.warnings = [
          clampWarning(
            language === "ja"
              ? `チャンピオン情報の取得に失敗しました: ${factsWarning}`
              : `Champion facts lookup failed: ${factsWarning}`
          ),
          ...coaching.meta.warnings
        ];
      }
      if (dbWarning) {
        coaching.meta.warnings = [
          clampWarning(
            language === "ja"
              ? "データベースの参照に失敗しました。キャッシュなしでコーチングを表示します。"
              : dbWarning
          ),
          ...coaching.meta.warnings
        ];
      }
      if (!hasEnoughSample) {
        coaching.meta.warnings = [
          clampWarning(
            language === "ja"
              ? `追加データ収集中 (${currentSampleSize}/${requiredSampleGames})。暫定データが表示される場合があります。`
              : `Collecting more games (${currentSampleSize}/${requiredSampleGames}); provisional data may be shown.`
          ),
          ...coaching.meta.warnings
        ];
      }
      coaching.meta.warnings = coaching.meta.warnings.map(clampWarning);
      if (lane === "bot" && coaching.meta.winRate == null && primaryStats) {
        coaching.meta.winRate = Number(primaryStats.winRate.toFixed(3));
      }
      const parseOutput = coachMatchupResponseSchema.safeParse(coaching);

      if (!parseOutput.success) {
        return res.status(500).json({
          error: "Generated coaching output failed schema validation.",
          details: parseOutput.error.flatten()
        });
      }

      return res.json(parseOutput.data);
    } catch (error) {
      return res.status(500).json({
        error: "Failed to generate matchup coaching.",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  router.get("/admin/cache-status", async (req, res) => {
    if (!statsRepository) {
      return res.status(503).json({
        error: "Stats repository is unavailable."
      });
    }

    const patch = String(req.query.patch ?? currentPatch);
    const laneRaw = req.query.lane;
    const normalizedLaneRaw = typeof laneRaw === "string" ? laneRaw.trim().toLowerCase() : "";
    const isBotAggregate = normalizedLaneRaw === "bot";
    const lane =
      normalizedLaneRaw.length > 0 && !isBotAggregate
        ? normalizeLane(normalizedLaneRaw)
        : undefined;
    try {
      const overview = await (
        isBotAggregate
          ? (() => {
            return Promise.all([
              statsRepository.getCacheOverview(patch, "adc"),
              statsRepository.getCacheOverview(patch, "support")
            ]).then(([adc, support]) => ({
              totalCount: adc.totalCount + support.totalCount,
              freshCount: adc.freshCount + support.freshCount,
              staleCount: adc.staleCount + support.staleCount,
              latestComputedAt: [adc.latestComputedAt, support.latestComputedAt]
                .filter((v): v is string => Boolean(v))
                .sort()
                .at(-1) ?? null
            }));
          })()
          : statsRepository.getCacheOverview(patch, lane)
      );
      const totalPossiblePairs =
        lane === "top"
          ? SUPPORTED_TOP_CHAMPIONS.length * (SUPPORTED_TOP_CHAMPIONS.length - 1)
          : isBotAggregate
            ? 0
            : 0;
      return res.json({
        patch,
        lane: isBotAggregate ? "bot" : lane ?? "all",
        championsSupported: lane === "top" ? SUPPORTED_TOP_CHAMPIONS.length : null,
        totalPossiblePairs,
        cachedPairs: overview.totalCount,
        freshPairs: overview.freshCount,
        stalePairs: overview.staleCount,
        coveragePct:
          totalPossiblePairs > 0 ? Number(((overview.totalCount / totalPossiblePairs) * 100).toFixed(1)) : 0,
        latestComputedAt: overview.latestComputedAt
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to inspect cache status.",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  router.get("/admin/cache-status-by-lane", async (req, res) => {
    if (!statsRepository) {
      return res.status(503).json({
        error: "Stats repository is unavailable."
      });
    }

    const patch = String(req.query.patch ?? currentPatch);
    try {
      const laneSummaries = await Promise.all(
        SUPPORTED_LANES.map(async (lane) => {
          const [overview, champions] = await Promise.all([
            statsRepository.getCacheOverview(patch, lane),
            statsRepository.listChampionsByLane(patch, lane, 400)
          ]);
          const championCount = champions.length;
          const totalPossiblePairs = championCount > 1 ? championCount * (championCount - 1) : 0;
          const coveragePct =
            totalPossiblePairs > 0 ? Number(((overview.totalCount / totalPossiblePairs) * 100).toFixed(1)) : 0;

          return {
            lane,
            championsInCache: championCount,
            totalPossiblePairs,
            cachedPairs: overview.totalCount,
            freshPairs: overview.freshCount,
            archivedPairs: overview.staleCount,
            coveragePct,
            latestComputedAt: overview.latestComputedAt
          };
        })
      );

      return res.json({
        patch,
        lanes: laneSummaries
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to inspect cache status by lane.",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  router.get("/admin/cached-pairs", async (req, res) => {
    if (!statsRepository) {
      return res.status(503).json({
        error: "Stats repository is unavailable."
      });
    }

    const patch = String(req.query.patch ?? currentPatch);
    const laneRaw = req.query.lane;
    const normalizedLaneRaw = typeof laneRaw === "string" ? laneRaw.trim().toLowerCase() : "";
    const isBotAggregate = normalizedLaneRaw === "bot";
    const lane =
      normalizedLaneRaw.length > 0 && !isBotAggregate
        ? normalizeLane(normalizedLaneRaw)
        : undefined;
    const limitRaw = Number(req.query.limit ?? 500);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : 500;
    const freshOnly = String(req.query.freshOnly ?? "false") === "true";

    try {
      const pairs =
        isBotAggregate
          ? (
            await Promise.all([
              statsRepository.listCachedPairs(patch, { lane: "adc", limit, freshOnly }),
              statsRepository.listCachedPairs(patch, { lane: "support", limit, freshOnly })
            ])
          )
            .flat()
            .slice(0, limit)
          : await statsRepository.listCachedPairs(patch, { lane, limit, freshOnly });
      return res.json({
        patch,
        lane: isBotAggregate ? "bot" : lane ?? "all",
        count: pairs.length,
        pairs
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to list cached pairs.",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  router.post("/feedback", async (req, res) => {
    try {
      if (!options.dbClient) {
        return res.status(503).json({ error: "Database not configured for feedback." });
      }

      const parsed = feedbackRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid feedback payload", details: parsed.error.issues });
      }

      const { patch, lane, playerChampion, enemyChampion, rating, comment } = parsed.data;
      const createdAt = new Date().toISOString();

      if (options.dbClient.type === "postgres") {
        await options.dbClient.pool.query(
          `INSERT INTO matchup_feedback (patch, lane, player_champion, enemy_champion, rating, comment, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
          [patch, lane, playerChampion, enemyChampion, rating, comment ?? null, createdAt]
        );
      } else {
        await options.dbClient.db.run(
          `INSERT INTO matchup_feedback (patch, lane, player_champion, enemy_champion, rating, comment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [patch, lane, playerChampion, enemyChampion, rating, comment ?? null, createdAt]
        );
      }

      return res.json({ success: true });
    } catch (error) {
      console.error("[feedback] Failed to save feedback:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/admin/feedback", async (req, res) => {
    // Simple local-only restriction
    const isLocal = req.ip === "::1" || req.ip === "127.0.0.1" || (req.ip ?? "").includes("::ffff:127.0.0.1");
    if (!isLocal) {
      return res.status(403).json({ error: "Access denied. Admin routes are restricted to localhost." });
    }

    if (!options.dbClient) {
      return res.status(503).json({ error: "Database not configured for feedback." });
    }

    try {
      let rows: any[] = [];
      if (options.dbClient.type === "postgres") {
        const result = await options.dbClient.pool.query(
          `SELECT id, patch, lane, player_champion as "playerChampion", enemy_champion as "enemyChampion", rating, comment, created_at as "createdAt"
           FROM matchup_feedback
           ORDER BY created_at DESC`
        );
        rows = result.rows;
      } else {
        rows = await options.dbClient.db.all(
          `SELECT id, patch, lane, player_champion as playerChampion, enemy_champion as enemyChampion, rating, comment, created_at as createdAt
           FROM matchup_feedback
           ORDER BY created_at DESC`
        );
      }
      return res.json({ success: true, feedback: rows });
    } catch (error) {
      console.error("[feedback] Failed to get feedback:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/admin/llm-status", async (_req, res) => {
    if (!geminiCoachService) {
      return res.json({
        configured: false,
        status: "api_error",
        message: "Gemini is not configured. Add GEMINI_API_KEY in .env."
      });
    }

    try {
      const status = await geminiCoachService.getStatus();
      return res.json(status);
    } catch (error) {
      return res.status(500).json({
        configured: true,
        status: "api_error",
        message: error instanceof Error ? error.message : "Failed to check Gemini status."
      });
    }
  });

  return router;
}
