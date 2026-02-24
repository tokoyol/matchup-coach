import { RiotMatchupStatsService } from "./riotMatchupStatsService.js";
import type { SupportedLane } from "../data/champions.js";

interface BackfillRequest {
  patch: string;
  lane: SupportedLane;
  playerChampion: string;
  enemyChampion: string;
  targetGames?: number;
}

interface MissingPairBackfillOptions {
  enabled: boolean;
  maxQueueSize: number;
  cooldownMs: number;
  maxTrackedPlayers: number;
  maxMatchesPerPlayer: number;
  maxUniqueMatchIds?: number;
}

type CollectionState = "queued" | "processing" | "complete" | "partial" | "error";

interface CollectionSnapshot {
  key: string;
  patch: string;
  lane: SupportedLane;
  playerChampion: string;
  enemyChampion: string;
  targetGames: number;
  latestGames: number;
  state: CollectionState;
  updatedAt: string;
  message?: string;
}

export class MissingPairBackfillService {
  private readonly queue: BackfillRequest[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly snapshots = new Map<string, CollectionSnapshot>();
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
    const targetGames = Math.max(1, Math.floor(input.targetGames ?? 10));
    this.snapshots.set(key, {
      key,
      patch: input.patch,
      lane: input.lane,
      playerChampion: input.playerChampion,
      enemyChampion: input.enemyChampion,
      targetGames,
      latestGames: this.snapshots.get(key)?.latestGames ?? 0,
      state: "queued",
      updatedAt: new Date().toISOString()
    });
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
        const targetGames = Math.max(1, Math.floor(next.targetGames ?? 10));
        const previous = this.snapshots.get(key);
        this.snapshots.set(key, {
          key,
          patch: next.patch,
          lane: next.lane,
          playerChampion: next.playerChampion,
          enemyChampion: next.enemyChampion,
          targetGames,
          latestGames: previous?.latestGames ?? 0,
          state: "processing",
          updatedAt: new Date().toISOString()
        });

        try {
          const stats = await this.riotStatsService.getMatchupStats({
            lane: next.lane,
            playerChampion: next.playerChampion,
            enemyChampion: next.enemyChampion,
            patch: next.patch,
            maxTrackedPlayers: this.options.maxTrackedPlayers,
            maxMatchesPerPlayer: this.options.maxMatchesPerPlayer,
            maxUniqueMatchIds: this.options.maxUniqueMatchIds ?? 700,
            targetGames
          });
          const latestGames = stats?.games ?? 0;
          this.snapshots.set(key, {
            key,
            patch: next.patch,
            lane: next.lane,
            playerChampion: next.playerChampion,
            enemyChampion: next.enemyChampion,
            targetGames,
            latestGames,
            state: latestGames >= targetGames ? "complete" : "partial",
            updatedAt: new Date().toISOString(),
            message:
              latestGames >= targetGames
                ? "Target sample reached."
                : `Collected ${latestGames}/${targetGames} games so far.`
          });
        } catch {
          const previous = this.snapshots.get(key);
          this.snapshots.set(key, {
            key,
            patch: next.patch,
            lane: next.lane,
            playerChampion: next.playerChampion,
            enemyChampion: next.enemyChampion,
            targetGames,
            latestGames: previous?.latestGames ?? 0,
            state: "error",
            updatedAt: new Date().toISOString(),
            message: "Collection attempt failed."
          });
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

  getCollectionStatus(input: {
    patch: string;
    lane: SupportedLane;
    playerChampion: string;
    enemyChampion: string;
  }): CollectionSnapshot | null {
    return this.snapshots.get(this.keyOf(input)) ?? null;
  }
}
