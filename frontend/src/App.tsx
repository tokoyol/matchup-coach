import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { COPY, detectInitialLanguage, formatTemplate, persistLanguage, type AppLanguage } from "./i18n";

type Difficulty = "easy" | "favored" | "even" | "not_favored" | "hard";
type CoachLane = "top" | "jungle" | "mid" | "bot";
type DataLane = "top" | "jungle" | "mid" | "adc" | "support";
type BotPlayerRole = "adc" | "support";

interface ChampionsResponse {
  lane: CoachLane | DataLane;
  patch: string;
  champions: string[];
}

interface ChampionLocalizationResponse {
  language: AppLanguage;
  patch: string;
  names: Record<string, string>;
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

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const AUTO_REFRESH_INTERVAL_MS = 6000;

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
  const normalized = action.trim().toLowerCase();
  return (
    normalized === "take a short commit trade and disengage before return damage." ||
    normalized === "use full combo and hold one key spell to secure the kill attempt." ||
    normalized === "take a short commit trade and disengage if the enemy cooldowns return."
  );
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
  const [patch, setPatch] = useState<string>("--");
  const [playerChampion, setPlayerChampion] = useState<string>("");
  const [enemyChampion, setEnemyChampion] = useState<string>("");
  const [playerChampionPartner, setPlayerChampionPartner] = useState<string>("");
  const [enemyChampionPartner, setEnemyChampionPartner] = useState<string>("");
  const [playerRole, setPlayerRole] = useState<BotPlayerRole>("adc");
  const [result, setResult] = useState<CoachResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string>("");
  const [submitError, setSubmitError] = useState<string>("");
  const [showDifficultyHelp, setShowDifficultyHelp] = useState<boolean>(false);
  const [jaChampionNames, setJaChampionNames] = useState<Record<string, string>>({});
  const copy = COPY[language];

  useEffect(() => {
    persistLanguage(language);
  }, [language]);

  useEffect(() => {
    if (language !== "ja") return;
    if (Object.keys(jaChampionNames).length > 0) return;

    let active = true;
    const loadJapaneseChampionNames = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/champion-localization?language=ja`);
        if (!response.ok) return;
        const payload = (await response.json()) as ChampionLocalizationResponse;
        const jaByChampionKey = payload.names ?? {};
        if (!active) return;
        setJaChampionNames(jaByChampionKey);
      } catch {
        // Keep English champion labels if external localization fetch fails.
      }
    };

    void loadJapaneseChampionNames();
    return () => {
      active = false;
    };
  }, [language, jaChampionNames]);

  const championLabel = useCallback(
    (championName: string): string => {
      if (language !== "ja") return championName;
      return jaChampionNames[championNameKey(championName)] ?? championName;
    },
    [language, jaChampionNames]
  );

  useEffect(() => {
    let active = true;
    const loadChampions = async () => {
      setLoadError("");
      try {
        const responses =
          selectedLane === "bot"
            ? await Promise.all([
                fetch(`${API_BASE}/api/champions?lane=adc`),
                fetch(`${API_BASE}/api/champions?lane=support`)
              ])
            : [await fetch(`${API_BASE}/api/champions?lane=${encodeURIComponent(selectedLane)}`)];

        const failedResponse = responses.find((response) => !response.ok);
        if (failedResponse) throw new Error(`Failed to load champions (${failedResponse.status})`);

        const payloads = (await Promise.all(
          responses.map((response) => response.json() as Promise<ChampionsResponse>)
        )) as ChampionsResponse[];
        if (!active) return;

        const primaryPool = payloads[0]?.champions ?? [];
        const partnerPool = selectedLane === "bot" ? payloads[1]?.champions ?? [] : [];
        const patchValue = payloads[0]?.patch ?? "--";

        setPrimaryChampions(primaryPool);
        setPartnerChampions(partnerPool);
        setPatch(patchValue);
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

  return (
    <div className="page">
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
        <p>{formatTemplate(copy.app.patch, { patch })}</p>
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
              <label>
                {copy.form.roles.adc}
                <select value={playerChampion} onChange={(e) => setPlayerChampion(e.target.value)}>
                  {primaryChampions.map((champion) => (
                    <option key={champion} value={champion}>
                      {championLabel(champion)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {copy.form.roles.support}
                <select value={playerChampionPartner} onChange={(e) => setPlayerChampionPartner(e.target.value)}>
                  {partnerChampions.map((champion) => (
                    <option key={champion} value={champion}>
                      {championLabel(champion)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section className="card botlane-side">
              <h3>{copy.form.enemyBotlane}</h3>
              <label>
                {copy.form.roles.adc}
                <select value={enemyChampion} onChange={(e) => setEnemyChampion(e.target.value)}>
                  {enemyOptions.map((champion) => (
                    <option key={champion} value={champion}>
                      {championLabel(champion)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {copy.form.roles.support}
                <select value={enemyChampionPartner} onChange={(e) => setEnemyChampionPartner(e.target.value)}>
                  {enemyPartnerOptions.map((champion) => (
                    <option key={champion} value={champion}>
                      {championLabel(champion)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            </div>
          </>
        ) : (
          <div className="botlane-grid">
            <section className="card botlane-side">
              <h3>{formatTemplate(copy.form.allyLane, { lane: copy.form.lanes[selectedLane] })}</h3>
              <label>
                {copy.form.champion}
                <select value={playerChampion} onChange={(e) => setPlayerChampion(e.target.value)}>
                  {primaryChampions.map((champion) => (
                    <option key={champion} value={champion}>
                      {championLabel(champion)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section className="card botlane-side">
              <h3>{formatTemplate(copy.form.enemyLane, { lane: copy.form.lanes[selectedLane] })}</h3>
              <label>
                {copy.form.champion}
                <select value={enemyChampion} onChange={(e) => setEnemyChampion(e.target.value)}>
                  {enemyOptions.map((champion) => (
                    <option key={champion} value={champion}>
                      {championLabel(champion)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          </div>
        )}

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
              {copy.form.lanes[result.matchup.lane]} | {result.matchup.patch}
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
                  {!isGenericAllInAction(window.action) ? <> {"->"} {window.action}</> : null}
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

    </div>
  );
}
