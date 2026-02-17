import { RiotMatchupStatsService } from "./riotMatchupStatsService.js";
import type { SupportedLane } from "../data/champions.js";

interface BackfillRequest {
  patch: string;
  lane: SupportedLane;
  playerChampion: string;
  enemyChampion: string;
}

interface MissingPairBackfillOptions {
  enabled: boolean;
  maxQueueSize: number;
  cooldownMs: number;
  maxTrackedPlayers: number;
  maxMatchesPerPlayer: number;
}

export class MissingPairBackfillService {
  private readonly queue: BackfillRequest[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly lastAttemptAt = new Map<string, number>();
  private processing = false;
  private currentKey: string | null = null;

  constructor(
    private readonly riotStatsService: RiotMatchupStatsService,
    private readonly options: MissingPairBackfillOptions
  ) {}

  private keyOf(input: BackfillRequest): string {
    return `${input.patch}:${input.lane}:${input.playerChampion}:${input.enemyChampion}`;
  }

  private canAttempt(key: string): boolean {
    const lastAt = this.lastAttemptAt.get(key);
    if (!lastAt) return true;
    return Date.now() - lastAt >= this.options.cooldownMs;
  }

  enqueue(input: BackfillRequest): { queued: boolean; reason?: string } {
    if (!this.options.enabled) return { queued: false, reason: "disabled" };

    const key = this.keyOf(input);
    if (!this.canAttempt(key)) return { queued: false, reason: "cooldown" };
    if (this.currentKey === key || this.queuedKeys.has(key)) return { queued: false, reason: "already_queued" };
    if (this.queue.length >= this.options.maxQueueSize) return { queued: false, reason: "queue_full" };

    this.queue.push(input);
    this.queuedKeys.add(key);
    this.processLoop().catch(() => {
      // Keep this background worker best-effort and non-fatal.
    });
    return { queued: true };
  }

  private async processLoop(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) continue;

        const key = this.keyOf(next);
        this.currentKey = key;
        this.queuedKeys.delete(key);
        this.lastAttemptAt.set(key, Date.now());

        try {
          await this.riotStatsService.getMatchupStats({
            lane: next.lane,
            playerChampion: next.playerChampion,
            enemyChampion: next.enemyChampion,
            patch: next.patch,
            maxTrackedPlayers: this.options.maxTrackedPlayers,
            maxMatchesPerPlayer: this.options.maxMatchesPerPlayer
          });
        } catch {
          // Ignore errors; route fallback already handles user experience.
        } finally {
          this.currentKey = null;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  getStatus(): {
    enabled: boolean;
    queueDepth: number;
    processing: boolean;
    currentKey: string | null;
    maxQueueSize: number;
  } {
    return {
      enabled: this.options.enabled,
      queueDepth: this.queue.length,
      processing: this.processing,
      currentKey: this.currentKey,
      maxQueueSize: this.options.maxQueueSize
    };
  }
}
