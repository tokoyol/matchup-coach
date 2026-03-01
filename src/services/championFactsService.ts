import { championKey } from "../data/champions.js";

export type ChampionResourceType = "mana" | "energy" | "manaless" | "fury" | "other";

export interface ChampionFacts {
  championId: string;
  canonicalName: string;
  displayNameEn: string;
  displayNameJa: string;
  resourceType: ChampionResourceType;
}

interface DDragonChampionPayload {
  data: Record<
    string,
    {
      id: string;
      name: string;
      partype?: string;
    }
  >;
}

interface ChampionFactsCache {
  fetchedAt: number;
  patch: string;
  factsByKey: Record<string, ChampionFacts>;
}

function mapResourceType(raw: string | undefined): ChampionResourceType {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "mana") return "mana";
  if (normalized === "energy") return "energy";
  if (normalized === "none") return "manaless";
  if (normalized === "fury") return "fury";
  return "other";
}

export class ChampionFactsService {
  private cache: ChampionFactsCache | null = null;

  constructor(private readonly cacheTtlMs = 1000 * 60 * 60 * 6) {}

  private isCacheFresh(nowMs: number): boolean {
    if (!this.cache) return false;
    return nowMs - this.cache.fetchedAt < this.cacheTtlMs;
  }

  private async fetchLatestFacts(): Promise<ChampionFactsCache> {
    const versionsResponse = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
    if (!versionsResponse.ok) {
      throw new Error(`Failed to fetch Data Dragon versions (HTTP ${versionsResponse.status}).`);
    }
    const versions = (await versionsResponse.json()) as string[];
    const patch = versions[0];
    if (!patch) {
      throw new Error("Data Dragon returned no versions.");
    }

    const [enResponse, jaResponse] = await Promise.all([
      fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`),
      fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/ja_JP/champion.json`)
    ]);
    if (!enResponse.ok || !jaResponse.ok) {
      throw new Error(`Failed to fetch champion facts payloads (${enResponse.status}/${jaResponse.status}).`);
    }

    const [enData, jaData] = (await Promise.all([
      enResponse.json() as Promise<DDragonChampionPayload>,
      jaResponse.json() as Promise<DDragonChampionPayload>
    ])) as [DDragonChampionPayload, DDragonChampionPayload];

    const factsByKey: Record<string, ChampionFacts> = {};
    Object.values(enData.data).forEach((enChampion) => {
      const jaChampion = jaData.data[enChampion.id];
      const facts: ChampionFacts = {
        championId: enChampion.id,
        canonicalName: enChampion.name,
        displayNameEn: enChampion.name,
        displayNameJa: jaChampion?.name ?? enChampion.name,
        resourceType: mapResourceType(enChampion.partype)
      };

      factsByKey[championKey(enChampion.id)] = facts;
      factsByKey[championKey(enChampion.name)] = facts;
    });

    return {
      fetchedAt: Date.now(),
      patch,
      factsByKey
    };
  }

  async getChampionFacts(championName: string): Promise<ChampionFacts | null> {
    const now = Date.now();
    if (!this.isCacheFresh(now)) {
      this.cache = await this.fetchLatestFacts();
    }
    const key = championKey(championName);
    if (!key || !this.cache) return null;
    return this.cache.factsByKey[key] ?? null;
  }

  async getStatus(): Promise<{ patch: string | null; loaded: boolean; championCount: number }> {
    const now = Date.now();
    if (!this.isCacheFresh(now)) {
      this.cache = await this.fetchLatestFacts();
    }
    return {
      patch: this.cache?.patch ?? null,
      loaded: Boolean(this.cache),
      championCount: this.cache ? new Set(Object.values(this.cache.factsByKey).map((facts) => facts.championId)).size : 0
    };
  }
}
