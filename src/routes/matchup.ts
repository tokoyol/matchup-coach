import { Request, Router } from "express";
import {
  SUPPORTED_LANES,
  SUPPORTED_TOP_CHAMPIONS,
  normalizeChampionName,
  normalizeCoachLane,
  normalizeLane
} from "../data/champions.js";
import { coachMatchupRequestSchema, coachMatchupResponseSchema } from "../schemas/matchup.js";
import { generateMatchupCoaching } from "../services/coachService.js";
import type { ExternalMatchupStatsProvider } from "../services/externalMatchupStatsProvider.js";
import { GeminiCoachService } from "../services/geminiCoachService.js";
import { MissingPairBackfillService } from "../services/missingPairBackfillService.js";
import { RiotPrecomputeService } from "../services/riotPrecomputeService.js";
import { RiotApiClient } from "../services/riotApiClient.js";
import { RiotMatchupStatsService } from "../services/riotMatchupStatsService.js";
import type { MatchupStatsStore } from "../services/matchupStatsStore.js";
import type { MatchupStats } from "../types/stats.js";

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

function combineBotStats(primary: MatchupStats | null, partner: MatchupStats | null): MatchupStats | null {
  if (!primary && !partner) return null;
  if (primary && !partner) return primary;
  if (!primary && partner) return partner;
  const left = primary as MatchupStats;
  const right = partner as MatchupStats;
  const totalGames = Math.max(1, left.games + right.games);
  const weighted = (a: number, aGames: number, b: number, bGames: number): number =>
    Number(((a * aGames + b * bGames) / totalGames).toFixed(3));

  return {
    patch: left.patch,
    games: totalGames,
    winRate: weighted(left.winRate, left.games, right.winRate, right.games),
    goldDiff15: Math.round((left.goldDiff15 * left.games + right.goldDiff15 * right.games) / totalGames),
    pre6KillRate: weighted(left.pre6KillRate, left.games, right.pre6KillRate, right.games),
    earlyDeathRate: weighted(left.earlyDeathRate, left.games, right.earlyDeathRate, right.games),
    runeUsage: left.runeUsage.length > 0 ? left.runeUsage : right.runeUsage,
    firstItemUsage: left.firstItemUsage.length > 0 ? left.firstItemUsage : right.firstItemUsage,
    computedAt: new Date().toISOString()
  };
}

function clampWarning(message: string): string {
  const trimmed = message.trim();
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117).trim()}...`;
}

interface CreateMatchupRouterOptions {
  currentPatch: string;
  enableLiveStats: boolean;
  minSampleGames?: number;
  statsRepository?: MatchupStatsStore;
  riotStatsService?: RiotMatchupStatsService;
  riotApiClient?: RiotApiClient;
  riotPrecomputeService?: RiotPrecomputeService;
  missingPairBackfillService?: MissingPairBackfillService;
  externalStatsProvider?: ExternalMatchupStatsProvider;
  geminiCoachService?: GeminiCoachService;
  adminApiToken?: string;
}

export function createMatchupRouter(options: CreateMatchupRouterOptions): Router {
  const {
    currentPatch,
    enableLiveStats,
    minSampleGames,
    statsRepository,
    riotStatsService,
    riotApiClient,
    riotPrecomputeService,
    missingPairBackfillService,
    externalStatsProvider,
    geminiCoachService,
    adminApiToken
  } = options;
  const requiredSampleGames = Math.max(1, Math.floor(minSampleGames ?? 10));
  const router = Router();

  const requireAdminToken = (req: Request): boolean => {
    if (!adminApiToken) return true;
    const headerToken = String(req.headers["x-admin-token"] ?? "");
    return headerToken.length > 0 && headerToken === adminApiToken;
  };

  router.get("/champions", async (req, res) => {
    try {
      const rawLane = String(req.query.lane ?? "top").trim().toLowerCase();
      const isBotAggregate = rawLane === "bot";
      const dataLane = normalizeLane(rawLane);
      const lane = isBotAggregate ? "bot" : dataLane;
      const dynamicChampions = isBotAggregate
        ? statsRepository
          ? [
              ...(await statsRepository.listChampionsByLane(currentPatch, "adc", 400)),
              ...(await statsRepository.listChampionsByLane(currentPatch, "support", 400))
            ]
          : []
        : statsRepository
          ? await statsRepository.listChampionsByLane(currentPatch, dataLane, 400)
          : [];
      const champions =
        lane === "top"
          ? [...new Set([...SUPPORTED_TOP_CHAMPIONS, ...dynamicChampions])]
          : [...new Set(dynamicChampions)];
      return res.json({
        lane,
        patch: currentPatch,
        champions: champions.sort((a, b) => a.localeCompare(b))
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
      const lane = normalizeCoachLane(parseInput.data.lane);
      let primaryStats: MatchupStats | null = null;
      let partnerStats: MatchupStats | null = null;
      let riotPrimaryStats: MatchupStats | null = null;
      let riotPartnerStats: MatchupStats | null = null;
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
      let liveStatsWarning = "";
      let usedExternalProvider: string | null = null;
      const patch = parseInput.data.patch ?? currentPatch;
      const botlaneContexts =
        lane === "bot" && parseInput.data.playerChampionPartner && parseInput.data.enemyChampionPartner && parseInput.data.playerRole
          ? {
              playerRole: parseInput.data.playerRole,
              allyAdc: parseInput.data.playerChampion,
              allySupport: parseInput.data.playerChampionPartner,
              enemyAdc: parseInput.data.enemyChampion,
              enemySupport: parseInput.data.enemyChampionPartner
            }
          : undefined;
      if (enableLiveStats && riotStatsService) {
        try {
          if (lane === "bot") {
            const [adcStats, supportStats] = await Promise.all([
              withTimeout(
                riotStatsService.getMatchupStats({
                  lane: "adc",
                  playerChampion: parseInput.data.playerChampion,
                  enemyChampion: parseInput.data.enemyChampion,
                  patch,
                  targetGames: requiredSampleGames
                }),
                8_000,
                "Live Riot stats timed out."
              ),
              withTimeout(
                riotStatsService.getMatchupStats({
                  lane: "support",
                  playerChampion: parseInput.data.playerChampionPartner ?? "",
                  enemyChampion: parseInput.data.enemyChampionPartner ?? "",
                  patch,
                  targetGames: requiredSampleGames
                }),
                8_000,
                "Live Riot stats timed out."
              )
            ]);
            riotPrimaryStats = adcStats;
            riotPartnerStats = supportStats;
            primaryStats = riotPrimaryStats;
            partnerStats = riotPartnerStats;
          } else {
            riotPrimaryStats = await withTimeout(
              riotStatsService.getMatchupStats({
                lane,
                playerChampion: parseInput.data.playerChampion,
                enemyChampion: parseInput.data.enemyChampion,
                patch,
                targetGames: requiredSampleGames
              }),
              8_000,
              "Live Riot stats timed out."
            );
            primaryStats = riotPrimaryStats;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown live stats error";
          if (message.includes("429")) {
            liveStatsWarning = "Live Riot stats temporarily rate-limited; using fallback coaching output.";
          } else if (message.includes("timed out")) {
            liveStatsWarning = "Live Riot stats timed out; using fallback coaching output.";
          } else {
            liveStatsWarning = "Live Riot stats unavailable; using fallback coaching output.";
          }
        }
      }

      const riotSampleSize = (riotPrimaryStats?.games ?? 0) + (riotPartnerStats?.games ?? 0);
      if (externalStatsProvider && riotSampleSize < requiredSampleGames) {
        try {
          if (lane === "bot") {
            const [externalAdc, externalSupport] = await Promise.all([
              withTimeout(
                externalStatsProvider.getMatchupStats({
                  lane: "adc",
                  patch,
                  playerChampion: parseInput.data.playerChampion,
                  enemyChampion: parseInput.data.enemyChampion
                }),
                4_000,
                "External matchup source timed out."
              ),
              withTimeout(
                externalStatsProvider.getMatchupStats({
                  lane: "support",
                  patch,
                  playerChampion: parseInput.data.playerChampionPartner ?? "",
                  enemyChampion: parseInput.data.enemyChampionPartner ?? ""
                }),
                4_000,
                "External matchup source timed out."
              )
            ]);
            const adcResult = externalAdc.result;
            const supportResult = externalSupport.result;
            if (adcResult?.stats && (primaryStats?.games ?? 0) < adcResult.stats.games) {
              externalPrimaryStats = adcResult.stats;
              primaryStats = adcResult.stats;
              usedExternalProvider = adcResult.provider;
            }
            if (supportResult?.stats && (partnerStats?.games ?? 0) < supportResult.stats.games) {
              externalPartnerStats = supportResult.stats;
              partnerStats = supportResult.stats;
              usedExternalProvider = supportResult.provider;
            }
            const preferredOutcome =
              [externalAdc, externalSupport].find((o) => o.status !== "success" && o.status !== "cache_hit") ??
              externalAdc;
            externalSourceMeta = {
              provider: preferredOutcome.provider,
              status: preferredOutcome.status,
              failureReason: preferredOutcome.failureReason,
              httpStatus: preferredOutcome.httpStatus
            };
          } else {
            const externalStats = await withTimeout(
              externalStatsProvider.getMatchupStats({
                lane,
                patch,
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
            if (externalResult?.stats && (primaryStats?.games ?? 0) < externalResult.stats.games) {
              externalPrimaryStats = externalResult.stats;
              primaryStats = externalResult.stats;
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

      const currentSampleSize = (primaryStats?.games ?? 0) + (partnerStats?.games ?? 0);
      const externalSampleSize = (externalPrimaryStats?.games ?? 0) + (externalPartnerStats?.games ?? 0);
      const hasEnoughSample = currentSampleSize >= requiredSampleGames;
      const shouldQueueCollection = enableLiveStats && riotSampleSize < requiredSampleGames;
      const statsForCoaching = lane === "bot" ? combineBotStats(primaryStats, partnerStats) : primaryStats;
      const partnerStatsForCoaching = lane === "bot" ? null : partnerStats;

      const coaching = await generateMatchupCoaching(
        {
          ...parseInput.data,
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
          botlaneContexts
        }
      );
      if (liveStatsWarning) {
        coaching.meta.warnings = [clampWarning(liveStatsWarning), ...coaching.meta.warnings];
      }
      if (usedExternalProvider) {
        coaching.meta.warnings = [
          clampWarning(`Using fast provisional stats from ${usedExternalProvider} while Riot sample backfill continues.`),
          ...coaching.meta.warnings
        ];
      } else if (externalSourceMeta && externalSourceMeta.status !== "success" && externalSourceMeta.status !== "cache_hit") {
        coaching.meta.warnings = [
          clampWarning(
            `External source unavailable (${externalSourceMeta.status})${externalSourceMeta.failureReason ? `: ${externalSourceMeta.failureReason}` : ""}`
          ),
          ...coaching.meta.warnings
        ];
      }
      if (shouldQueueCollection && missingPairBackfillService) {
        const queuedPrimary = missingPairBackfillService.enqueue({
          patch,
          lane: lane === "bot" ? "adc" : lane,
          playerChampion: parseInput.data.playerChampion,
          enemyChampion: parseInput.data.enemyChampion,
          targetGames: requiredSampleGames
        });
        const queuedPartner =
          lane === "bot" && parseInput.data.playerChampionPartner && parseInput.data.enemyChampionPartner
            ? missingPairBackfillService.enqueue({
                patch,
                lane: "support",
                playerChampion: parseInput.data.playerChampionPartner,
                enemyChampion: parseInput.data.enemyChampionPartner,
                targetGames: requiredSampleGames
              })
            : { queued: false };
        if (queuedPrimary.queued || queuedPartner.queued || !hasEnoughSample) {
          coaching.meta.warnings = [
            clampWarning(
              !hasEnoughSample
                ? `Collecting more games (${currentSampleSize}/${requiredSampleGames}); provisional data may be shown.`
                : lane === "bot"
                  ? "Queued background backfill for ADC/support matchup pairs."
                  : "Queued background backfill for this matchup pair."
            ),
            ...coaching.meta.warnings
          ];
        }
      }
      coaching.meta.warnings = coaching.meta.warnings.map(clampWarning);
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

  router.get("/admin/riot/matchup-stats", async (req, res) => {
    if (!enableLiveStats || !riotStatsService) {
      return res.status(503).json({
        error: "Live Riot stats are disabled. Set RIOT_ENABLE_LIVE_STATS=true and RIOT_API_KEY."
      });
    }

    const playerChampion = normalizeChampionName(String(req.query.playerChampion ?? ""));
    const enemyChampion = normalizeChampionName(String(req.query.enemyChampion ?? ""));
    const lane = normalizeLane(req.query.lane);
    const patch = String(req.query.patch ?? currentPatch);

    if (!playerChampion || !enemyChampion) {
      return res.status(400).json({
        error: "playerChampion and enemyChampion query params are required."
      });
    }

    try {
      const stats = await riotStatsService.getMatchupStats({
        lane,
        playerChampion,
        enemyChampion,
        patch
      });
      return res.json({
        matchup: { playerChampion, enemyChampion, patch, lane },
        stats
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to fetch Riot matchup stats.",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  router.post("/admin/precompute-cache", async (req, res) => {
    if (!requireAdminToken(req)) {
      return res.status(401).json({ error: "Unauthorized admin request." });
    }
    if (!enableLiveStats || !riotPrecomputeService) {
      return res.status(503).json({
        error: "Live Riot stats are disabled. Set RIOT_ENABLE_LIVE_STATS=true and RIOT_API_KEY."
      });
    }

    const parseInteger = (value: unknown, fallback: number): number => {
      const num = Number(value);
      return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
    };

    const patch = String(req.body?.patch ?? currentPatch);
    const lanesInput = Array.isArray(req.body?.lanes) ? (req.body.lanes as unknown[]) : undefined;
    const lanes = lanesInput
      ? lanesInput.map((lane) => normalizeLane(lane)).filter((lane, idx, arr) => arr.indexOf(lane) === idx)
      : [...SUPPORTED_LANES];
    const maxTrackedPlayers = parseInteger(req.body?.maxTrackedPlayers, 30);
    const matchesPerPlayer = parseInteger(req.body?.matchesPerPlayer, 8);
    const maxUniqueMatches = parseInteger(req.body?.maxUniqueMatches, 300);
    const concurrency = parseInteger(req.body?.concurrency, 3);

    try {
      const summary = await riotPrecomputeService.precomputeAll({
        patch,
        lanes,
        maxTrackedPlayers,
        matchesPerPlayer,
        maxUniqueMatches,
        concurrency
      });
      return res.json({
        ok: true,
        summary
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to precompute matchup cache.",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  router.get("/admin/cache-status", async (req, res) => {
    if (!enableLiveStats || !statsRepository) {
      return res.status(503).json({
        error: "Live Riot stats are disabled. Set RIOT_ENABLE_LIVE_STATS=true and RIOT_API_KEY."
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
    if (!enableLiveStats || !statsRepository) {
      return res.status(503).json({
        error: "Live Riot stats are disabled. Set RIOT_ENABLE_LIVE_STATS=true and RIOT_API_KEY."
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
    if (!enableLiveStats || !statsRepository) {
      return res.status(503).json({
        error: "Live Riot stats are disabled. Set RIOT_ENABLE_LIVE_STATS=true and RIOT_API_KEY."
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

  router.get("/admin/riot-key-status", async (_req, res) => {
    if (!enableLiveStats || !riotApiClient) {
      return res.json({
        configured: false,
        valid: false,
        expired: false,
        message: "Live Riot stats are disabled or RIOT_API_KEY is missing.",
        checkedAt: new Date().toISOString()
      });
    }

    try {
      const status = await riotApiClient.getApiKeyStatus();
      return res.json(status);
    } catch (error) {
      return res.status(500).json({
        configured: true,
        valid: false,
        expired: false,
        message: error instanceof Error ? error.message : "Failed to check Riot API key status.",
        checkedAt: new Date().toISOString()
      });
    }
  });

  router.get("/admin/backfill-status", (_req, res) => {
    if (!missingPairBackfillService) {
      return res.json({
        enabled: false,
        queueDepth: 0,
        processing: false,
        currentKey: null
      });
    }
    return res.json(missingPairBackfillService.getStatus());
  });

  router.get("/matchup-collection-status", (req, res) => {
    if (!missingPairBackfillService) {
      return res.json({
        enabled: false,
        snapshot: null
      });
    }

    const playerChampion = normalizeChampionName(String(req.query.playerChampion ?? ""));
    const enemyChampion = normalizeChampionName(String(req.query.enemyChampion ?? ""));
    const patch = String(req.query.patch ?? currentPatch);
    const lane = normalizeLane(req.query.lane);

    if (!playerChampion || !enemyChampion) {
      return res.status(400).json({
        error: "playerChampion and enemyChampion query params are required."
      });
    }

    return res.json({
      enabled: true,
      snapshot: missingPairBackfillService.getCollectionStatus({
        patch,
        lane,
        playerChampion,
        enemyChampion
      })
    });
  });

  return router;
}
