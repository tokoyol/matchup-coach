export const SUPPORTED_TOP_CHAMPIONS = [
  "Aatrox",
  "Camille",
  "Darius",
  "Fiora",
  "Garen",
  "Gnar",
  "Irelia",
  "Jax",
  "K'Sante",
  "Malphite",
  "Mordekaiser",
  "Nasus",
  "Ornn",
  "Renekton",
  "Riven",
  "Sett",
  "Shen",
  "Teemo",
  "Tryndamere",
  "Yorick"
] as const;

export const SUPPORTED_LANES = ["top", "jungle", "mid", "adc", "support"] as const;
export type SupportedLane = (typeof SUPPORTED_LANES)[number];
export const SUPPORTED_COACH_LANES = ["top", "jungle", "mid", "bot"] as const;
export type CoachLane = (typeof SUPPORTED_COACH_LANES)[number];

export const CHAMPION_TAGS: Record<string, string[]> = {
  Aatrox: ["melee", "sustain", "skillshot"],
  Camille: ["melee", "scaling", "engage"],
  Darius: ["lane_bully", "melee", "early_strong"],
  Fiora: ["melee", "duelist", "scaling"],
  Garen: ["melee", "simple", "all_in"],
  Gnar: ["ranged", "kite", "transform"],
  Irelia: ["melee", "snowball", "all_in"],
  Jax: ["melee", "scaling", "duelist"],
  "K'Sante": ["melee", "tank", "disrupt"],
  Malphite: ["tank", "anti_ad", "teamfight"],
  Mordekaiser: ["melee", "juggernaut", "isolator"],
  Nasus: ["melee", "scaling", "weak_early"],
  Ornn: ["tank", "safe", "teamfight"],
  Renekton: ["melee", "lane_bully", "early_strong"],
  Riven: ["melee", "all_in", "snowball"],
  Sett: ["melee", "brawler", "all_in"],
  Shen: ["tank", "global", "short_trade"],
  Teemo: ["ranged", "poke", "blind"],
  Tryndamere: ["melee", "crit", "splitpush"],
  Yorick: ["melee", "splitpush", "summoner"]
};

const CHAMPION_ALIASES: Record<string, string> = {
  ksante: "K'Sante",
  "k'sante": "K'Sante",
  "k sante": "K'Sante",
  drmundo: "Dr. Mundo",
  "dr mundo": "Dr. Mundo",
  nunuandwillump: "Nunu & Willump",
  nunu: "Nunu & Willump",
  wukong: "Wukong",
  monkeyking: "Wukong"
};

export function championKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function normalizeChampionName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const alias = CHAMPION_ALIASES[championKey(trimmed)];
  return alias ?? trimmed;
}

export function normalizeLane(raw: unknown): SupportedLane {
  const lane = String(raw ?? "").trim().toLowerCase();
  if (SUPPORTED_LANES.includes(lane as SupportedLane)) return lane as SupportedLane;
  return "top";
}

export function normalizeCoachLane(raw: unknown): CoachLane {
  const lane = String(raw ?? "").trim().toLowerCase();
  if (lane === "adc" || lane === "support") return "bot";
  if (SUPPORTED_COACH_LANES.includes(lane as CoachLane)) return lane as CoachLane;
  return "top";
}
