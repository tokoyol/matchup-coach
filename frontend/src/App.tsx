import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { COPY, detectInitialLanguage, formatTemplate, persistLanguage, type AppLanguage } from "./i18n";
import ChampionPicker from "./components/ChampionPicker";
import { AdminFeedbackDashboard } from "./AdminFeedbackDashboard";

type Difficulty = "easy" | "favored" | "even" | "not_favored" | "hard";
type CoachLane = "top" | "jungle" | "mid" | "bot";
type DataLane = "top" | "jungle" | "mid" | "adc" | "support";
type BotPlayerRole = "adc" | "support";

interface ChampionsResponse {
  lane: CoachLane | DataLane;
  patch: string;
  champions: string[];
}

interface ChampionMetadataResponse {
  patch: string;
  championsByKey: Record<
    string,
    {
      championId: string;
      canonicalName: string;
      displayNameEn: string;
      displayNameJa: string;
    }
  >;
}

interface DDragonVersionsResponse extends Array<string> { }
interface DDragonChampionListPayload {
  data: Record<
    string,
    {
      id: string;
      name: string;
    }
  >;
}

interface BestMatchupsResponse {
  patch: string;
  lane: DataLane;
  enemyChampion: string;
  matchups: Array<{
    playerChampion: string;
    winRate: number;
    games: number;
    difficulty: Difficulty;
  }>;
}

function championNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface CoachResponse {
  matchup: {
    playerChampion: string;
    enemyChampion: string;
    playerChampionPartner?: string;
    enemyChampionPartner?: string;
    playerRole?: BotPlayerRole;
    lane: CoachLane;
    patch: string;
  };
  difficulty: Difficulty;
  earlyGamePlan: string;
  level1to3Rules: string[];
  allInWindows: Array<{
    timing: "level_2" | "level_3" | "level_6" | "first_item" | "enemy_misstep";
    signal: string;
    action: string;
    isFallbackAction?: boolean;
  }>;
  runeAdjustments: {
    keystone: { recommended: string; reason: string };
    secondary: { tree: string; reason: string };
    shardsNote: string;
  };
  commonMistakes: [string, string, string];
  botlaneAdvice?: {
    playerRole: BotPlayerRole;
    vsEnemyAdc: {
      threatPattern: string;
      spacingRule: string;
      punishWindow: string;
      commonTrap: string;
    };
    vsEnemySupport: {
      threatPattern: string;
      spacingRule: string;
      punishWindow: string;
      commonTrap: string;
    };
  };
  meta: {
    generatedAt: string;
    dataConfidence: "low" | "medium" | "high";
    sampleSize: number;
    winRate: number | null;
    sampleTarget: number;
    providerSamples: {
      riotGames: number;
      externalGames: number;
      effectiveGames: number;
    };
    source: {
      stats: boolean;
      tags: boolean;
      rag: boolean;
      cacheHit: boolean;
    };
    warnings: string[];
  };
}

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  ? (import.meta.env.VITE_API_BASE_URL as string)
  : import.meta.env.DEV
    ? "http://localhost:4000"
    : window.location.origin;

if (typeof window !== "undefined") {
  (window as any)._frontendLogs = (window as any)._frontendLogs || [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    (window as any)._frontendLogs.push(args.map(a => String(a)).join(" "));
    originalLog(...args);
  };
}
const AUTO_REFRESH_INTERVAL_MS = 6000;

async function fetchChampionMetadataFromDDragon(): Promise<ChampionMetadataResponse> {
  const versionsResponse = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  if (!versionsResponse.ok) {
    throw new Error(`Failed to load Data Dragon versions (${versionsResponse.status}).`);
  }
  const versions = (await versionsResponse.json()) as DDragonVersionsResponse;
  const patch = versions[0];
  if (!patch) {
    throw new Error("Data Dragon returned empty versions.");
  }

  const [enResponse, jaResponse] = await Promise.all([
    fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/ja_JP/champion.json`)
  ]);
  if (!enResponse.ok || !jaResponse.ok) {
    throw new Error(`Failed to load Data Dragon champion metadata (${enResponse.status}/${jaResponse.status}).`);
  }
  const [enData, jaData] = (await Promise.all([
    enResponse.json() as Promise<DDragonChampionListPayload>,
    jaResponse.json() as Promise<DDragonChampionListPayload>
  ])) as [DDragonChampionListPayload, DDragonChampionListPayload];

  const championsByKey: ChampionMetadataResponse["championsByKey"] = {};
  Object.values(enData.data).forEach((enChampion) => {
    const jaChampion = jaData.data?.[enChampion.id];
    const model = {
      championId: enChampion.id,
      canonicalName: enChampion.name,
      displayNameEn: enChampion.name,
      displayNameJa: jaChampion?.name ?? enChampion.name
    };
    championsByKey[championNameKey(enChampion.id)] = model;
    championsByKey[championNameKey(enChampion.name)] = model;
  });
  return { patch, championsByKey };
}

function difficultyLabel(difficulty: Difficulty, language: AppLanguage): string {
  return COPY[language].enums.difficulty[difficulty];
}

function timingLabel(timing: CoachResponse["allInWindows"][number]["timing"], language: AppLanguage): string {
  const timings: Record<AppLanguage, Record<CoachResponse["allInWindows"][number]["timing"], string>> = {
    en: {
      level_2: "Level 2",
      level_3: "Level 3",
      level_6: "Level 6",
      first_item: "First Item",
      enemy_misstep: "Enemy Misstep"
    },
    ja: {
      level_2: "レベル2",
      level_3: "レベル3",
      level_6: "レベル6",
      first_item: "1コア完成",
      enemy_misstep: "敵のミス"
    }
  };
  return timings[language][timing];
}

function isGenericAllInAction(action: string): boolean {
  const normalized = action
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ");
  const exactTemplates = new Set([
    "take a short commit trade and disengage before return damage",
    "use full combo and hold one key spell to secure the kill attempt",
    "take a short commit trade and disengage if the enemy cooldowns return",
    "commit full combo with spacing and hold one spell for finish",
    "take a short commit trade and disengage after your combo",
    "commit full combo and hold one key spell for secure finish"
  ]);
  if (exactTemplates.has(normalized)) return true;

  // Catch slight phrasing drift from fallback templates.
  const isShortTradeTemplate =
    normalized.includes("short commit trade") &&
    (normalized.includes("disengage") || normalized.includes("return damage"));
  const isFullComboTemplate =
    normalized.includes("full combo") &&
    normalized.includes("hold one") &&
    normalized.includes("spell");
  return isShortTradeTemplate || isFullComboTemplate;
}

function hasRuneAdjustment(result: CoachResponse): boolean {
  const rune = result.runeAdjustments;
  return Boolean(
    rune.keystone.recommended.trim() ||
    rune.keystone.reason.trim() ||
    rune.secondary.tree.trim() ||
    rune.secondary.reason.trim() ||
    rune.shardsNote.trim()
  );
}

function runeSourceLabel(result: CoachResponse, language: AppLanguage): string {
  if (!hasRuneAdjustment(result)) return COPY[language].enums.runeSource.none;
  if (result.meta.source.rag) return COPY[language].enums.runeSource.gemini;
  if (result.meta.source.stats) return COPY[language].enums.runeSource.stats;
  return COPY[language].enums.runeSource.none;
}

export default function App() {
  const [language, setLanguage] = useState<AppLanguage>(() => detectInitialLanguage());
  const [primaryChampions, setPrimaryChampions] = useState<string[]>([]);
  const [partnerChampions, setPartnerChampions] = useState<string[]>([]);
  const [selectedLane, setSelectedLane] = useState<CoachLane>("top");
  const [systemPatch, setSystemPatch] = useState<string>("--");
  const [dataPatch, setDataPatch] = useState<string>("--");
  const [playerChampion, setPlayerChampion] = useState<string>("");
  const [enemyChampion, setEnemyChampion] = useState<string>("");
  const [playerChampionPartner, setPlayerChampionPartner] = useState<string>("");
  const [enemyChampionPartner, setEnemyChampionPartner] = useState<string>("");
  const [playerRole, setPlayerRole] = useState<BotPlayerRole>("adc");
  const [result, setResult] = useState<CoachResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string>("");
  const [submitError, setSubmitError] = useState<string>("");
  const [feedbackSubmitted, setFeedbackSubmitted] = useState<boolean>(false);
  const [feedbackRating, setFeedbackRating] = useState<"good" | "bad" | null>(null);
  const [feedbackComment, setFeedbackComment] = useState<string>("");
  const [showDifficultyHelp, setShowDifficultyHelp] = useState<boolean>(false);
  const [jaChampionNames, setJaChampionNames] = useState<Record<string, string>>({});
  const [championIdByKey, setChampionIdByKey] = useState<Record<string, string>>({});
  const [iconPatch, setIconPatch] = useState<string>("");
  const [bestMatchups, setBestMatchups] = useState<BestMatchupsResponse | null>(null);
  const [bestMatchupsLoading, setBestMatchupsLoading] = useState<boolean>(false);
  const copy = COPY[language];

  const [currentHash, setCurrentHash] = useState(window.location.hash);

  useEffect(() => {
    const onHashChange = () => setCurrentHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const fetchConfig = async () => {
      console.log("Fetching config from:", `${API_BASE}/api/config`);
      try {
        const response = await fetch(`${API_BASE}/api/config`);
        console.log("Config response status:", response.status);
        if (response.ok) {
          const data = await response.json();
          console.log("Config data:", JSON.stringify(data));
          setSystemPatch(data.patch);
        }
      } catch (err) {
        console.error("Failed to fetch system config", err);
      }
    };
    void fetchConfig();
  }, []);

  useEffect(() => {
    persistLanguage(language);
  }, [language]);

  useEffect(() => {
    if (Object.keys(championIdByKey).length > 0 && Object.keys(jaChampionNames).length > 0 && iconPatch) return;

    let active = true;
    const loadChampionMetadata = async () => {
      try {
        let payload: ChampionMetadataResponse | null = null;
        try {
          const response = await fetch(`${API_BASE}/api/champion-metadata`);
          if (response.ok) {
            payload = (await response.json()) as ChampionMetadataResponse;
          }
        } catch {
          // Fall through to Data Dragon direct lookup.
        }
        if (!payload) {
          payload = await fetchChampionMetadataFromDDragon();
        }
        const nextIdByKey: Record<string, string> = {};
        const nextJaByKey: Record<string, string> = {};
        Object.entries(payload.championsByKey ?? {}).forEach(([key, champion]) => {
          nextIdByKey[key] = champion.championId;
          nextJaByKey[key] = champion.displayNameJa;
        });
        if (!active) return;
        setIconPatch(payload.patch ?? "");
        setChampionIdByKey(nextIdByKey);
        setJaChampionNames(nextJaByKey);
      } catch {
        // Keep text-only picker labels/icons when metadata endpoint is unavailable.
      }
    };

    void loadChampionMetadata();
    return () => {
      active = false;
    };
  }, [championIdByKey, jaChampionNames, iconPatch]);

  const championLabel = useCallback(
    (championName: string): string => {
      if (language !== "ja") return championName;
      return jaChampionNames[championNameKey(championName)] ?? championName;
    },
    [language, jaChampionNames]
  );

  const championIconUrl = useCallback(
    (championName: string): string => {
      if (!iconPatch) return "";
      const key = championNameKey(championName);
      const championId = championIdByKey[key];
      if (!championId) return "";
      return `https://ddragon.leagueoflegends.com/cdn/${iconPatch}/img/champion/${championId}.png`;
    },
    [iconPatch, championIdByKey]
  );

  const pickerNoResultsLabel = language === "ja" ? "該当するチャンピオンがありません。" : "No champions found.";

  useEffect(() => {
    let active = true;
    const loadChampions = async () => {
      setLoadError("");
      try {
        console.log("Fetching champions from:", selectedLane);
        const responses =
          selectedLane === "bot"
            ? await Promise.all([
              fetch(`${API_BASE}/api/champions?lane=adc`),
              fetch(`${API_BASE}/api/champions?lane=support`)
            ])
            : [await fetch(`${API_BASE}/api/champions?lane=${encodeURIComponent(selectedLane)}`)];

        console.log("Champions responses statuses:", responses.map(r => r.status));
        const failedResponse = responses.find((response) => !response.ok);
        if (failedResponse) throw new Error(`Failed to load champions (${failedResponse.status})`);

        const payloads = (await Promise.all(
          responses.map((response) => response.json() as Promise<ChampionsResponse>)
        )) as ChampionsResponse[];
        console.log("Payloads results:", payloads.map(p => ({ lane: p.lane, count: p.champions?.length, patch: p.patch })));
        if (!active) return;

        const primaryPool = payloads[0]?.champions ?? [];
        const partnerPool = selectedLane === "bot" ? payloads[1]?.champions ?? [] : [];
        const patchValue = payloads[0]?.patch ?? "--";

        setPrimaryChampions(primaryPool);
        setPartnerChampions(partnerPool);
        setDataPatch(patchValue);
        setPlayerChampion((current) => (primaryPool.includes(current) ? current : primaryPool[0] ?? ""));
        setEnemyChampion((current) => (primaryPool.includes(current) ? current : primaryPool[1] ?? primaryPool[0] ?? ""));
        if (selectedLane === "bot") {
          setPlayerChampionPartner((current) => (partnerPool.includes(current) ? current : partnerPool[0] ?? ""));
          setEnemyChampionPartner((current) =>
            partnerPool.includes(current) ? current : partnerPool[1] ?? partnerPool[0] ?? ""
          );
        } else {
          setPlayerChampionPartner("");
          setEnemyChampionPartner("");
        }
      } catch (error) {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : copy.errors.loadChampions);
      }
    };
    loadChampions();
    return () => {
      active = false;
    };
  }, [selectedLane, copy.errors.loadChampions]);

  const enemyOptions = useMemo(() => {
    return primaryChampions.filter((champion) => champion !== playerChampion);
  }, [primaryChampions, playerChampion]);

  const enemyPartnerOptions = useMemo(() => {
    if (selectedLane !== "bot") return [];
    return partnerChampions.filter((champion) => champion !== playerChampionPartner);
  }, [selectedLane, partnerChampions, playerChampionPartner]);

  useEffect(() => {
    if (enemyOptions.length === 0) {
      setEnemyChampion("");
      return;
    }
    if (!enemyOptions.includes(enemyChampion)) {
      setEnemyChampion(enemyOptions[0]);
    }
  }, [enemyOptions, enemyChampion]);

  const bestMatchupsLane = selectedLane === "bot" ? playerRole : selectedLane;
  const bestMatchupsPatch = /^\d{2}\.\d{1,2}$/.test(dataPatch) ? dataPatch : systemPatch;
  const canFetchBestMatchups = Boolean(
    enemyChampion.trim().length >= 2 &&
    (selectedLane !== "bot" || playerRole)
  );
  useEffect(() => {
    if (!canFetchBestMatchups) {
      setBestMatchups(null);
      return;
    }
    if (!/^\d{2}\.\d{1,2}$/.test(bestMatchupsPatch)) {
      setBestMatchups(null);
      return;
    }
    let cancelled = false;
    setBestMatchupsLoading(true);
    const url = `${API_BASE}/api/best-matchups?patch=${encodeURIComponent(bestMatchupsPatch)}&lane=${encodeURIComponent(bestMatchupsLane)}&enemyChampion=${encodeURIComponent(enemyChampion)}&limit=3`;
    fetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: BestMatchupsResponse) => {
        if (!cancelled) {
          setBestMatchups(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBestMatchups(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBestMatchupsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canFetchBestMatchups, bestMatchupsPatch, bestMatchupsLane, enemyChampion]);

  useEffect(() => {
    if (selectedLane !== "bot") return;
    if (enemyPartnerOptions.length === 0) {
      setEnemyChampionPartner("");
      return;
    }
    if (!enemyPartnerOptions.includes(enemyChampionPartner)) {
      setEnemyChampionPartner(enemyPartnerOptions[0]);
    }
  }, [selectedLane, enemyPartnerOptions, enemyChampionPartner]);

  const canSubmit = useMemo(
    () =>
      !loading &&
      playerChampion.length > 0 &&
      enemyChampion.length > 0 &&
      playerChampion !== enemyChampion &&
      (selectedLane !== "bot" ||
        (playerChampionPartner.length > 0 &&
          enemyChampionPartner.length > 0 &&
          Boolean(playerRole) &&
          playerChampion !== playerChampionPartner &&
          enemyChampion !== enemyChampionPartner)),
    [loading, playerChampion, enemyChampion, selectedLane, playerChampionPartner, enemyChampionPartner, playerRole]
  );

  const requestCoaching = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitError("");
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/coach/matchup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lane: selectedLane,
          playerChampion,
          enemyChampion,
          language,
          ...(selectedLane === "bot"
            ? {
              playerRole,
              playerChampionPartner,
              enemyChampionPartner
            }
            : {})
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload?.error ??
          formatTemplate(copy.errors.requestFailed, {
            status: response.status
          })
        );
      }
      setResult(payload as CoachResponse);
      setFeedbackSubmitted(false);
      setFeedbackRating(null);
      setFeedbackComment("");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : copy.errors.fetchCoaching);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [
    canSubmit,
    selectedLane,
    playerRole,
    playerChampion,
    enemyChampion,
    playerChampionPartner,
    enemyChampionPartner,
    language,
    copy.errors.fetchCoaching,
    copy.errors.requestFailed
  ]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await requestCoaching();
  };

  const submitFeedback = async (rating: "good" | "bad", comment?: string) => {
    if (!result) return;
    try {
      await fetch(`${API_BASE}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patch: result.matchup.patch,
          lane: result.matchup.lane,
          playerChampion: result.matchup.playerChampion,
          enemyChampion: result.matchup.enemyChampion,
          rating,
          comment: comment?.trim() || undefined
        })
      });
      setFeedbackSubmitted(true);
    } catch (error) {
      console.error("Failed to submit feedback", error);
    }
  };

  const shouldAutoRefresh = useMemo(() => {
    if (!result || loading || submitError) return false;
    return result.meta.providerSamples.effectiveGames < result.meta.sampleTarget;
  }, [result, loading, submitError]);

  useEffect(() => {
    if (!shouldAutoRefresh) return;
    const timer = setTimeout(() => {
      void requestCoaching();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [shouldAutoRefresh, requestCoaching]);

  if (currentHash === "#/admin/feedback") {
    return <AdminFeedbackDashboard />;
  }

  return (
    <div className="page" lang={language}>
      <header className="hero">
        <div className="hero-row">
          <h1>{copy.app.title}</h1>
          <label className="language-select">
            {copy.app.languageLabel}
            <select value={language} onChange={(event) => setLanguage(event.target.value as AppLanguage)}>
              <option value="en">{copy.app.english}</option>
              <option value="ja">{copy.app.japanese}</option>
            </select>
          </label>
        </div>
        <p>{formatTemplate(copy.app.patch, { patch: systemPatch })}</p>
      </header>

      <form className="card form" onSubmit={onSubmit}>
        <div className="field-grid">
          <label>
            {copy.form.lane}
            <select value={selectedLane} onChange={(e) => setSelectedLane(e.target.value as CoachLane)}>
              <option value="top">{copy.form.lanes.top}</option>
              <option value="jungle">{copy.form.lanes.jungle}</option>
              <option value="mid">{copy.form.lanes.mid}</option>
              <option value="bot">{copy.form.lanes.bot}</option>
            </select>
          </label>
        </div>

        {selectedLane === "bot" ? (
          <>
            <div className="field-grid">
              <label>
                {copy.form.playerRole}
                <select value={playerRole} onChange={(e) => setPlayerRole(e.target.value as BotPlayerRole)}>
                  <option value="adc">{copy.form.roles.adc}</option>
                  <option value="support">{copy.form.roles.support}</option>
                </select>
              </label>
            </div>
            <div className="botlane-grid">
              <section className="card botlane-side">
                <h3>{copy.form.allyBotlane}</h3>
                <ChampionPicker
                  label={copy.form.roles.adc}
                  value={playerChampion}
                  options={primaryChampions}
                  onChange={setPlayerChampion}
                  getLabel={championLabel}
                  getIconUrl={championIconUrl}
                  noResultsLabel={pickerNoResultsLabel}
                />
                <ChampionPicker
                  label={copy.form.roles.support}
                  value={playerChampionPartner}
                  options={partnerChampions}
                  onChange={setPlayerChampionPartner}
                  getLabel={championLabel}
                  getIconUrl={championIconUrl}
                  noResultsLabel={pickerNoResultsLabel}
                />
              </section>
              <section className="card botlane-side">
                <h3>{copy.form.enemyBotlane}</h3>
                <ChampionPicker
                  label={copy.form.roles.adc}
                  value={enemyChampion}
                  options={enemyOptions}
                  onChange={setEnemyChampion}
                  getLabel={championLabel}
                  getIconUrl={championIconUrl}
                  noResultsLabel={pickerNoResultsLabel}
                />
                <ChampionPicker
                  label={copy.form.roles.support}
                  value={enemyChampionPartner}
                  options={enemyPartnerOptions}
                  onChange={setEnemyChampionPartner}
                  getLabel={championLabel}
                  getIconUrl={championIconUrl}
                  noResultsLabel={pickerNoResultsLabel}
                />
              </section>
            </div>
          </>
        ) : (
          <div className="botlane-grid">
            <section className="card botlane-side">
              <h3>{formatTemplate(copy.form.allyLane, { lane: copy.form.lanes[selectedLane] })}</h3>
              <ChampionPicker
                label={copy.form.champion}
                value={playerChampion}
                options={primaryChampions}
                onChange={setPlayerChampion}
                getLabel={championLabel}
                getIconUrl={championIconUrl}
                noResultsLabel={pickerNoResultsLabel}
              />
            </section>
            <section className="card botlane-side">
              <h3>{formatTemplate(copy.form.enemyLane, { lane: copy.form.lanes[selectedLane] })}</h3>
              <ChampionPicker
                label={copy.form.champion}
                value={enemyChampion}
                options={enemyOptions}
                onChange={setEnemyChampion}
                getLabel={championLabel}
                getIconUrl={championIconUrl}
                noResultsLabel={pickerNoResultsLabel}
              />
            </section>
          </div>
        )}

        <section className="best-matchups" aria-label={copy.bestMatchups.title} style={{ marginTop: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>
            {copy.bestMatchups.title.replace("{enemy}", championLabel(enemyChampion))}
          </h3>
          {!canFetchBestMatchups ? null : bestMatchupsLoading ? (
            <p className="hint" style={{ margin: 0 }}>{copy.form.submitLoading}</p>
          ) : bestMatchups?.matchups?.length ? (
            <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              {bestMatchups.matchups.map((m, i) => (
                <li key={`${m.playerChampion}-${i}`}>
                  <strong>{championLabel(m.playerChampion)}</strong>
                  {" — "}
                  {copy.bestMatchups.winRate}: {(m.winRate * 100).toFixed(1)}%
                  {" · "}
                  {copy.bestMatchups.games}: {m.games}
                  {" · "}
                  <span className={`difficulty ${m.difficulty}`}>{difficultyLabel(m.difficulty, language)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint" style={{ margin: 0 }}>{copy.bestMatchups.empty}</p>
          )}
        </section>

        <button type="submit" disabled={!canSubmit}>
          {loading ? copy.form.submitLoading : copy.form.submitIdle}
        </button>

        {loadError ? <p className="error">{loadError}</p> : null}
        {submitError ? <p className="error">{submitError}</p> : null}
        {!loadError && playerChampion === enemyChampion ? (
          <p className="hint">{copy.feedback.chooseDifferent}</p>
        ) : null}
        {!loadError &&
          selectedLane === "bot" &&
          (playerChampionPartner.length === 0 ||
            enemyChampionPartner.length === 0 ||
            playerChampion === playerChampionPartner ||
            enemyChampion === enemyChampionPartner) ? (
          <p className="hint">{copy.feedback.botlaneDifferent}</p>
        ) : null}
        {shouldAutoRefresh ? (
          <p className="hint">
            {formatTemplate(copy.feedback.autoRefresh, {
              seconds: Math.floor(AUTO_REFRESH_INTERVAL_MS / 1000),
              sampleTarget: result?.meta.sampleTarget ?? 10
            })}
          </p>
        ) : null}
      </form>

      {result ? (
        <main className="result-grid">
          <section className="card">
            <div className="title-row">
              <h2>{copy.result.matchupDifficulty}</h2>
              <span
                className="help-chip"
                aria-label={copy.result.difficultyHelpAria}
                role="button"
                tabIndex={0}
                onClick={() => setShowDifficultyHelp((v) => !v)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setShowDifficultyHelp((v) => !v);
                  }
                }}
              >
                ?
              </span>
            </div>
            {showDifficultyHelp ? (
              <p className="hint">{copy.result.difficultyHelp}</p>
            ) : null}
            <p className={`difficulty ${result.difficulty}`}>{difficultyLabel(result.difficulty, language)}</p>
            <p className="meta">
              {championLabel(result.matchup.playerChampion)} vs {championLabel(result.matchup.enemyChampion)} |{" "}
              {copy.form.lanes[result.matchup.lane]} | {formatTemplate(copy.app.patch, { patch: result.matchup.patch })}
              {result.matchup.patch !== systemPatch && (
                <span style={{ marginLeft: "0.5rem", color: "var(--warning)" }}>
                  ({language === "ja" ? "前回のパッチのデータを使用中" : "Using data from previous patch"})
                </span>
              )}
            </p>
            <p className="meta">
              {copy.result.winRate}:{" "}
              {result.meta.winRate !== null ? `${(result.meta.winRate * 100).toFixed(1)}%` : copy.result.notAvailable}
            </p>
            {result.matchup.lane === "bot" && result.matchup.playerChampionPartner && result.matchup.enemyChampionPartner ? (
              <p className="meta">
                {copy.result.duo}: {championLabel(result.matchup.playerChampion)} +{" "}
                {championLabel(result.matchup.playerChampionPartner)} vs {championLabel(result.matchup.enemyChampion)} +{" "}
                {championLabel(result.matchup.enemyChampionPartner)}
              </p>
            ) : null}

            <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "1rem" }}>
              {feedbackSubmitted ? (
                <p className="hint" style={{ margin: 0, color: "var(--primary)" }}>{copy.result.feedbackThanks}</p>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <p className="meta" style={{ margin: 0 }}>{copy.result.feedbackPrompt}</p>
                    <button
                      type="button"
                      className={`chip ${feedbackRating === "good" ? "active" : ""}`}
                      onClick={() => setFeedbackRating("good")}
                      style={{ padding: "0.25rem 0.6rem" }}
                    >
                      👍 {copy.result.feedbackGood}
                    </button>
                    <button
                      type="button"
                      className={`chip ${feedbackRating === "bad" ? "active" : ""}`}
                      onClick={() => setFeedbackRating("bad")}
                      style={{ padding: "0.25rem 0.6rem" }}
                    >
                      👎 {copy.result.feedbackBad}
                    </button>
                  </div>
                  {feedbackRating && (
                    <div className="feedback-comment-container">
                      <textarea
                        className="feedback-textarea"
                        placeholder={copy.result.feedbackComment}
                        value={feedbackComment}
                        onChange={(e) => setFeedbackComment(e.target.value)}
                      />
                      <div className="feedback-submit-row">
                        <button
                          type="button"
                          className="chip"
                          onClick={() => void submitFeedback(feedbackRating, feedbackComment)}
                          style={{ padding: "0.4rem 0.8rem", background: "var(--primary)", borderColor: "var(--primary)" }}
                        >
                          {copy.result.feedbackSubmit}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="card">
            <h2>{result.matchup.lane === "bot" ? copy.result.combinedDuoPlan : copy.result.earlyGamePlan}</h2>
            <p>{result.earlyGamePlan}</p>
          </section>

          {result.matchup.lane === "bot" && result.botlaneAdvice ? (
            <>
              <section className="card">
                <h2>{copy.result.vsEnemyAdc}</h2>
                <ul>
                  <li>
                    <strong>{copy.result.threatPattern}:</strong> {result.botlaneAdvice.vsEnemyAdc.threatPattern}
                  </li>
                  <li>
                    <strong>{copy.result.spacingRule}:</strong> {result.botlaneAdvice.vsEnemyAdc.spacingRule}
                  </li>
                  <li>
                    <strong>{copy.result.punishWindow}:</strong> {result.botlaneAdvice.vsEnemyAdc.punishWindow}
                  </li>
                  <li>
                    <strong>{copy.result.commonTrap}:</strong> {result.botlaneAdvice.vsEnemyAdc.commonTrap}
                  </li>
                </ul>
              </section>
              <section className="card">
                <h2>{copy.result.vsEnemySupport}</h2>
                <ul>
                  <li>
                    <strong>{copy.result.threatPattern}:</strong> {result.botlaneAdvice.vsEnemySupport.threatPattern}
                  </li>
                  <li>
                    <strong>{copy.result.spacingRule}:</strong> {result.botlaneAdvice.vsEnemySupport.spacingRule}
                  </li>
                  <li>
                    <strong>{copy.result.punishWindow}:</strong> {result.botlaneAdvice.vsEnemySupport.punishWindow}
                  </li>
                  <li>
                    <strong>{copy.result.commonTrap}:</strong> {result.botlaneAdvice.vsEnemySupport.commonTrap}
                  </li>
                </ul>
              </section>
            </>
          ) : null}

          <section className="card">
            <h2>{copy.result.levelRules}</h2>
            <ul>
              {result.level1to3Rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>{copy.result.allInWindows}</h2>
            <ul>
              {result.allInWindows.map((window) => (
                <li key={`${window.timing}-${window.signal}`}>
                  <strong>{timingLabel(window.timing, language)}:</strong> {window.signal}
                  {!(window.isFallbackAction ?? isGenericAllInAction(window.action)) ? <> {"->"} {window.action}</> : null}
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>{copy.result.runeAdjustments}</h2>
            <p className="hint">
              {copy.result.source}: {runeSourceLabel(result, language)}
            </p>
            {hasRuneAdjustment(result) ? (
              <ul>
                {result.runeAdjustments.keystone.recommended || result.runeAdjustments.keystone.reason ? (
                  <li>
                    <strong>{copy.result.keystone}:</strong> {result.runeAdjustments.keystone.recommended}
                    {result.runeAdjustments.keystone.reason
                      ? ` (${result.runeAdjustments.keystone.reason})`
                      : ""}
                  </li>
                ) : null}
                {result.runeAdjustments.secondary.tree || result.runeAdjustments.secondary.reason ? (
                  <li>
                    <strong>{copy.result.secondary}:</strong> {result.runeAdjustments.secondary.tree}
                    {result.runeAdjustments.secondary.reason
                      ? ` (${result.runeAdjustments.secondary.reason})`
                      : ""}
                  </li>
                ) : null}
                {result.runeAdjustments.shardsNote ? (
                  <li>
                    <strong>{copy.result.shardNote}:</strong> {result.runeAdjustments.shardsNote}
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="hint">{copy.result.noRuneAdjustment}</p>
            )}
          </section>

          <section className="card">
            <h2>{copy.result.commonMistakes}</h2>
            <ul>
              {result.commonMistakes.map((mistake) => (
                <li key={mistake}>{mistake}</li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>{copy.result.dataQuality}</h2>
            <ul>
              <li>
                <strong>{copy.result.confidence}:</strong> {result.meta.dataConfidence}
              </li>
              <li>
                <strong>{copy.result.sampleSize}:</strong> {result.meta.sampleSize}
              </li>
              <li>
                <strong>{copy.result.statsUsed}:</strong> {String(result.meta.source.stats)}
              </li>
              <li>
                <strong>{copy.result.generated}:</strong>{" "}
                {new Date(result.meta.generatedAt).toLocaleString(language === "ja" ? "ja-JP" : "en-US")}
              </li>
            </ul>
            {result.meta.warnings.length > 0 ? (
              <p className="hint">{result.meta.warnings.join(" ")}</p>
            ) : null}
          </section>
        </main>
      ) : null}

      <footer style={{ marginTop: "4rem", opacity: 0.5, fontSize: "0.8rem", textAlign: "center" }}>
        <p>&copy; 2026 Matchup Coach - {systemPatch}</p>
        <div id="debug-log-container" style={{ display: "none", textAlign: "left", background: "#f0f0f0", padding: "1rem", color: "#333" }}>
          <h3>Debug Logs</h3>
          <pre id="frontend-debug-log" style={{ whiteSpace: "pre-wrap" }}>
            {((window as any)._frontendLogs || []).join("\n")}
          </pre>
        </div>
        <button onClick={() => {
          const el = document.getElementById("debug-log-container");
          if (el) el.style.display = el.style.display === "none" ? "block" : "none";
        }} style={{ opacity: 0.1 }}>DEBUG</button>
      </footer>
    </div>
  );
}
