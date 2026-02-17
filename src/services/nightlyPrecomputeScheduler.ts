import { RiotPrecomputeService } from "./riotPrecomputeService.js";

export interface NightlyScheduleOptions {
  patch: string;
  hourUtc: number;
  maxTrackedPlayers: number;
  matchesPerPlayer: number;
  maxUniqueMatches: number;
  concurrency: number;
}

function msUntilNextRun(hourUtc: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function startNightlyPrecompute(
  service: RiotPrecomputeService,
  options: NightlyScheduleOptions
): void {
  const clampedHour = Math.min(23, Math.max(0, Math.floor(options.hourUtc)));

  const scheduleNext = (): void => {
    const waitMs = msUntilNextRun(clampedHour);
    setTimeout(async () => {
      try {
        const summary = await service.precomputeAll({
          patch: options.patch,
          maxTrackedPlayers: options.maxTrackedPlayers,
          matchesPerPlayer: options.matchesPerPlayer,
          maxUniqueMatches: options.maxUniqueMatches,
          concurrency: options.concurrency
        });
        console.log(
          `[nightly-precompute] completed patch=${summary.patch} pairsWritten=${summary.pairsWritten} durationMs=${summary.durationMs}`
        );
      } catch (error) {
        console.error("[nightly-precompute] failed:", error);
      } finally {
        scheduleNext();
      }
    }, waitMs);
  };

  scheduleNext();
}
