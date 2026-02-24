type JsonObject = Record<string, unknown>;

interface RiotClientConfig {
  apiKey: string;
  platformRoute: string;
  regionalRoute: string;
  minIntervalMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  rateLimitCooldownMs?: number;
}

export interface RiotApiKeyStatus {
  configured: boolean;
  valid: boolean;
  expired: boolean;
  httpStatus?: number;
  message: string;
  checkedAt: string;
}

export class RiotApiClient {
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAtMs = 0;
  private cooldownUntilMs = 0;

  constructor(private readonly config: RiotClientConfig) {}

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getRetryDelayMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);
    }
    const base = this.config.retryBaseMs ?? 800;
    return base * 2 ** attempt;
  }

  private activateCooldown(delayMs: number): void {
    const fallback = this.config.rateLimitCooldownMs ?? 45_000;
    const durationMs = Math.max(delayMs, fallback);
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, Date.now() + durationMs);
  }

  private enqueue<T>(handler: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const minInterval = this.config.minIntervalMs ?? 150;
      const now = Date.now();
      const waitMs = Math.max(0, this.lastRequestAtMs + minInterval - now);
      if (waitMs > 0) await this.sleep(waitMs);
      this.lastRequestAtMs = Date.now();
      return handler();
    });

    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async request<T>(
    hostType: "platform" | "regional",
    path: string,
    query?: Record<string, string | number | boolean>
  ): Promise<T> {
    if (Date.now() < this.cooldownUntilMs) {
      const secondsLeft = Math.ceil((this.cooldownUntilMs - Date.now()) / 1000);
      throw new Error(`Riot API cooldown active (${secondsLeft}s remaining) after rate limit.`);
    }

    const host =
      hostType === "platform"
        ? `https://${this.config.platformRoute}.api.riotgames.com`
        : `https://${this.config.regionalRoute}.api.riotgames.com`;

    const params = new URLSearchParams();
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        params.set(key, String(value));
      });
    }

    const url = `${host}${path}${params.size > 0 ? `?${params.toString()}` : ""}`;

    let lastError: Error | null = null;
    const maxRetries = this.config.maxRetries ?? 2;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.enqueue(() =>
        fetch(url, {
          method: "GET",
          headers: {
            "X-Riot-Token": this.config.apiKey
          }
        })
      );

      if (response.ok) {
        return (await response.json()) as T;
      }

      const text = await response.text();
      lastError = new Error(`Riot API ${response.status} ${response.statusText}: ${text}`);
      const canRetry = response.status === 429 && attempt < maxRetries;
      if (response.status === 429) {
        this.activateCooldown(this.getRetryDelayMs(response, attempt));
      }
      if (!canRetry) throw lastError;

      const delayMs = this.getRetryDelayMs(response, attempt);
      await this.sleep(delayMs);
    }

    throw lastError ?? new Error("Riot API request failed.");
  }

  async getMasterLeagueEntries(
    queue = "RANKED_SOLO_5x5"
  ): Promise<Array<{ puuid?: string; summonerId?: string }>> {
    const [challenger, grandmaster, master] = await Promise.all([
      this.request<JsonObject>("platform", `/lol/league/v4/challengerleagues/by-queue/${queue}`),
      this.request<JsonObject>("platform", `/lol/league/v4/grandmasterleagues/by-queue/${queue}`),
      this.request<JsonObject>("platform", `/lol/league/v4/masterleagues/by-queue/${queue}`)
    ]);

    const entries: Array<{ puuid?: string; summonerId?: string }> = [];
    for (const payload of [challenger, grandmaster, master]) {
      const leagueEntries = (payload.entries ?? []) as Array<Record<string, unknown>>;
      for (const e of leagueEntries) {
        const puuid = typeof e.puuid === "string" ? e.puuid : undefined;
        const summonerId = typeof e.summonerId === "string" ? e.summonerId : undefined;
        if (puuid || summonerId) entries.push({ puuid, summonerId });
      }
    }
    return entries;
  }

  async getPuuidBySummonerId(summonerId: string): Promise<string> {
    const data = await this.request<JsonObject>("platform", `/lol/summoner/v4/summoners/${summonerId}`);
    const puuid = data.puuid;
    if (typeof puuid !== "string") {
      throw new Error(`Missing puuid for summoner ${summonerId}`);
    }
    return puuid;
  }

  async getMatchIdsByPuuid(
    puuid: string,
    options?: { queue?: number; count?: number; startTime?: number }
  ): Promise<string[]> {
    const data = await this.request<unknown[]>(
      "regional",
      `/lol/match/v5/matches/by-puuid/${puuid}/ids`,
      {
        queue: options?.queue ?? 420,
        count: options?.count ?? 10,
        ...(options?.startTime ? { startTime: options.startTime } : {})
      }
    );
    return data.filter((entry): entry is string => typeof entry === "string");
  }

  async getMatch(matchId: string): Promise<JsonObject> {
    return this.request<JsonObject>("regional", `/lol/match/v5/matches/${matchId}`);
  }

  async getMatchTimeline(matchId: string): Promise<JsonObject> {
    return this.request<JsonObject>("regional", `/lol/match/v5/matches/${matchId}/timeline`);
  }

  async getApiKeyStatus(): Promise<RiotApiKeyStatus> {
    if (!this.config.apiKey) {
      return {
        configured: false,
        valid: false,
        expired: false,
        message: "RIOT_API_KEY is not configured.",
        checkedAt: new Date().toISOString()
      };
    }

    const url = `https://${this.config.platformRoute}.api.riotgames.com/lol/status/v4/platform-data`;
    try {
      const response = await this.enqueue(() =>
        fetch(url, {
          method: "GET",
          headers: {
            "X-Riot-Token": this.config.apiKey
          }
        })
      );
      if (response.ok) {
        return {
          configured: true,
          valid: true,
          expired: false,
          httpStatus: response.status,
          message: "Riot API key is valid.",
          checkedAt: new Date().toISOString()
        };
      }

      const text = await response.text();
      const expired = response.status === 401 || response.status === 403;
      return {
        configured: true,
        valid: false,
        expired,
        httpStatus: response.status,
        message: `Riot API key check failed: HTTP ${response.status}. ${text.slice(0, 220)}`,
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        configured: true,
        valid: false,
        expired: false,
        message: error instanceof Error ? error.message : "Unknown network error while checking Riot key.",
        checkedAt: new Date().toISOString()
      };
    }
  }
}
