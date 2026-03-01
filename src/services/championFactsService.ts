import { championKey } from "../data/champions.js";

export type ChampionResourceType = "mana" | "energy" | "manaless" | "fury" | "other";
export type ChampionSpellRole = "damage" | "cc" | "engage" | "disengage" | "mobility" | "zone" | "sustain";

export interface ChampionSpellFact {
  slot: "Q" | "W" | "E" | "R";
  spellId: string;
  displayNameEn: string;
  displayNameJa: string;
  roles: ChampionSpellRole[];
}

export interface ChampionFacts {
  championId: string;
  canonicalName: string;
  displayNameEn: string;
  displayNameJa: string;
  resourceType: ChampionResourceType;
  spellFacts: ChampionSpellFact[];
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

interface DDragonChampionFullPayload {
  data: Record<
    string,
    {
      id: string;
      name: string;
      partype?: string;
      spells: Array<{
        id: string;
        name: string;
        description?: string;
        tooltip?: string;
      }>;
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

function classifySpellRoles(raw: string): ChampionSpellRole[] {
  const text = raw.toLowerCase();
  const roles = new Set<ChampionSpellRole>();

  if (/\bdeals?\b|\bdamage\b|physical damage|magic damage|true damage/.test(text)) roles.add("damage");
  if (/\bstun\b|\broot\b|\bslow\b|\bfear\b|\btaunt\b|\bcharm\b|\bknock up\b|\bknockup\b|\bknockdown\b|\bpull\b|\bairborne\b|\bsuppress\b/.test(text)) {
    roles.add("cc");
  }
  if (/\bzone\b|area\b|field\b|lingers?\b|persists?\b|for \d+(?:\.\d+)? seconds?/.test(text)) roles.add("zone");
  if (/\bdash\b|\bblink\b|\bleap\b|\breposition\b|\bmovement speed\b|\bmove speed\b|\bunstoppable\b/.test(text)) {
    roles.add("mobility");
  }
  if (/\bgap close\b|\bcloser\b|dashes? to\b|leaps? to\b|pulls? target\b|pulls? enemies?\b/.test(text)) {
    roles.add("engage");
  }
  if (/\bknocks? back\b|\bpushes? (?:them|target|enemies?) away\b|\bretreat\b|\bescape\b|\bdisengage\b/.test(text)) {
    roles.add("disengage");
  }
  if (/\bheal\b|\bshield\b|\bomnivamp\b|\blifesteal\b|restores? health\b/.test(text)) roles.add("sustain");

  if (roles.size === 0) {
    roles.add("damage");
  }
  return [...roles];
}

function applySpellRoleOverrides(championId: string, slot: "Q" | "W" | "E" | "R", roles: ChampionSpellRole[]): ChampionSpellRole[] {
  // Known edge case: Aatrox W is a catch/zone tool, not a disengage tool.
  if (championId === "Aatrox" && slot === "W") {
    return ["cc", "zone", "engage"];
  }
  return roles;
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

    const [enResponse, jaResponse, enFullResponse, jaFullResponse] = await Promise.all([
      fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`),
      fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/ja_JP/champion.json`),
      fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/championFull.json`),
      fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/ja_JP/championFull.json`)
    ]);
    if (!enResponse.ok || !jaResponse.ok || !enFullResponse.ok || !jaFullResponse.ok) {
      throw new Error(
        `Failed to fetch champion facts payloads (${enResponse.status}/${jaResponse.status}/${enFullResponse.status}/${jaFullResponse.status}).`
      );
    }

    const [enData, jaData, enFullData, jaFullData] = (await Promise.all([
      enResponse.json() as Promise<DDragonChampionPayload>,
      jaResponse.json() as Promise<DDragonChampionPayload>,
      enFullResponse.json() as Promise<DDragonChampionFullPayload>,
      jaFullResponse.json() as Promise<DDragonChampionFullPayload>
    ])) as [DDragonChampionPayload, DDragonChampionPayload, DDragonChampionFullPayload, DDragonChampionFullPayload];

    const factsByKey: Record<string, ChampionFacts> = {};
    const slots: Array<"Q" | "W" | "E" | "R"> = ["Q", "W", "E", "R"];
    Object.values(enData.data).forEach((enChampion) => {
      const jaChampion = jaData.data[enChampion.id];
      const enFullChampion = enFullData.data[enChampion.id];
      const jaFullChampion = jaFullData.data[enChampion.id];
      const spellFacts: ChampionSpellFact[] = (enFullChampion?.spells ?? []).slice(0, 4).map((spell, idx) => {
        const slot = slots[idx] ?? "Q";
        const jaSpell = jaFullChampion?.spells?.[idx];
        const roles = applySpellRoleOverrides(
          enChampion.id,
          slot,
          classifySpellRoles(`${spell.description ?? ""} ${spell.tooltip ?? ""}`)
        );
        return {
          slot,
          spellId: spell.id,
          displayNameEn: spell.name,
          displayNameJa: jaSpell?.name ?? spell.name,
          roles
        };
      });
      const facts: ChampionFacts = {
        championId: enChampion.id,
        canonicalName: enChampion.name,
        displayNameEn: enChampion.name,
        displayNameJa: jaChampion?.name ?? enChampion.name,
        resourceType: mapResourceType(enChampion.partype),
        spellFacts
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

  private async getOrRefreshCache(): Promise<ChampionFactsCache> {
    const now = Date.now();
    if (!this.isCacheFresh(now)) {
      this.cache = await this.fetchLatestFacts();
    }
    if (!this.cache) {
      throw new Error("Champion facts cache unavailable.");
    }
    return this.cache;
  }

  async getChampionFacts(championName: string): Promise<ChampionFacts | null> {
    const cache = await this.getOrRefreshCache();
    const key = championKey(championName);
    if (!key) return null;
    return cache.factsByKey[key] ?? null;
  }

  async getStatus(): Promise<{ patch: string | null; loaded: boolean; championCount: number }> {
    const cache = await this.getOrRefreshCache();
    return {
      patch: cache.patch,
      loaded: true,
      championCount: new Set(Object.values(cache.factsByKey).map((facts) => facts.championId)).size
    };
  }

  async getFactsByKey(): Promise<{ patch: string; factsByKey: Record<string, ChampionFacts> }> {
    const cache = await this.getOrRefreshCache();
    return {
      patch: cache.patch,
      factsByKey: cache.factsByKey
    };
  }
}
