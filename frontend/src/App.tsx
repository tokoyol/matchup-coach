import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Difficulty = "easy" | "favored" | "even" | "not_favored" | "hard";
type CoachLane = "top" | "jungle" | "mid" | "bot";
type DataLane = "top" | "jungle" | "mid" | "adc" | "support";

interface ChampionsResponse {
  lane: CoachLane | DataLane;
  patch: string;
  champions: string[];
}

interface CoachResponse {
  matchup: {
    playerChampion: string;
    enemyChampion: string;
    playerChampionPartner?: string;
    enemyChampionPartner?: string;
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

function difficultyLabel(difficulty: Difficulty): string {
  if (difficulty === "easy") return "Easy";
  if (difficulty === "favored") return "Favored";
  if (difficulty === "not_favored") return "Not Favored";
  if (difficulty === "hard") return "Hard";
  return "Even";
}

function timingLabel(timing: CoachResponse["allInWindows"][number]["timing"]): string {
  return timing.replaceAll("_", " ").replace(/\b\w/g, (s) => s.toUpperCase());
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

function runeSourceLabel(result: CoachResponse): "From Gemini" | "From matchup stats" | "No adjustment" {
  if (!hasRuneAdjustment(result)) return "No adjustment";
  if (result.meta.source.rag) return "From Gemini";
  if (result.meta.source.stats) return "From matchup stats";
  return "No adjustment";
}

export default function App() {
  const [primaryChampions, setPrimaryChampions] = useState<string[]>([]);
  const [partnerChampions, setPartnerChampions] = useState<string[]>([]);
  const [selectedLane, setSelectedLane] = useState<CoachLane>("top");
  const [patch, setPatch] = useState<string>("--");
  const [playerChampion, setPlayerChampion] = useState<string>("");
  const [enemyChampion, setEnemyChampion] = useState<string>("");
  const [playerChampionPartner, setPlayerChampionPartner] = useState<string>("");
  const [enemyChampionPartner, setEnemyChampionPartner] = useState<string>("");
  const [result, setResult] = useState<CoachResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string>("");
  const [submitError, setSubmitError] = useState<string>("");
  const [showDifficultyHelp, setShowDifficultyHelp] = useState<boolean>(false);

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
        setLoadError(error instanceof Error ? error.message : "Failed to load champions.");
      }
    };
    loadChampions();
    return () => {
      active = false;
    };
  }, [selectedLane]);

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
          playerChampion !== playerChampionPartner &&
          enemyChampion !== enemyChampionPartner)),
    [loading, playerChampion, enemyChampion, selectedLane, playerChampionPartner, enemyChampionPartner]
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
          ...(selectedLane === "bot"
            ? {
                playerChampionPartner,
                enemyChampionPartner
              }
            : {})
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? `Request failed (${response.status})`);
      }
      setResult(payload as CoachResponse);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to fetch coaching output.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [
    canSubmit,
    selectedLane,
    playerChampion,
    enemyChampion,
    playerChampionPartner,
    enemyChampionPartner
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
        <h1>Lane Matchup Coach</h1>
        <p>Patch {patch} | MVP Focus: pre-lane preparation by role</p>
      </header>

      <form className="card form" onSubmit={onSubmit}>
        <div className="field-grid">
          <label>
            Lane
            <select value={selectedLane} onChange={(e) => setSelectedLane(e.target.value as CoachLane)}>
              <option value="top">Top</option>
              <option value="jungle">Jungle</option>
              <option value="mid">Mid</option>
              <option value="bot">Bot (ADC + Support)</option>
            </select>
          </label>
        </div>

        {selectedLane === "bot" ? (
          <div className="botlane-grid">
            <section className="card botlane-side">
              <h3>Ally Botlane</h3>
              <label>
                ADC
                <select value={playerChampion} onChange={(e) => setPlayerChampion(e.target.value)}>
                  {primaryChampions.map((champion) => (
                    <option key={champion} value={champion}>
                      {champion}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Support
                <select value={playerChampionPartner} onChange={(e) => setPlayerChampionPartner(e.target.value)}>
                  {partnerChampions.map((champion) => (
                    <option key={champion} value={champion}>
                      {champion}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section className="card botlane-side">
              <h3>Enemy Botlane</h3>
              <label>
                ADC
                <select value={enemyChampion} onChange={(e) => setEnemyChampion(e.target.value)}>
                  {enemyOptions.map((champion) => (
                    <option key={champion} value={champion}>
                      {champion}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Support
                <select value={enemyChampionPartner} onChange={(e) => setEnemyChampionPartner(e.target.value)}>
                  {enemyPartnerOptions.map((champion) => (
                    <option key={champion} value={champion}>
                      {champion}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          </div>
        ) : (
          <div className="botlane-grid">
            <section className="card botlane-side">
              <h3>Ally {selectedLane.toUpperCase()}</h3>
              <label>
                Champion
                <select value={playerChampion} onChange={(e) => setPlayerChampion(e.target.value)}>
                  {primaryChampions.map((champion) => (
                    <option key={champion} value={champion}>
                      {champion}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section className="card botlane-side">
              <h3>Enemy {selectedLane.toUpperCase()}</h3>
              <label>
                Champion
                <select value={enemyChampion} onChange={(e) => setEnemyChampion(e.target.value)}>
                  {enemyOptions.map((champion) => (
                    <option key={champion} value={champion}>
                      {champion}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          </div>
        )}

        <button type="submit" disabled={!canSubmit}>
          {loading ? "Generating..." : "Get Matchup Coaching"}
        </button>

        {loadError ? <p className="error">{loadError}</p> : null}
        {submitError ? <p className="error">{submitError}</p> : null}
        {!loadError && playerChampion === enemyChampion ? (
          <p className="hint">Choose two different champions.</p>
        ) : null}
        {!loadError &&
        selectedLane === "bot" &&
        (playerChampionPartner.length === 0 ||
          enemyChampionPartner.length === 0 ||
          playerChampion === playerChampionPartner ||
          enemyChampion === enemyChampionPartner) ? (
          <p className="hint">For bot lane, choose both duo champions and keep ADC/support picks different.</p>
        ) : null}
        {shouldAutoRefresh ? (
          <p className="hint">
            Collecting more sample data... auto-refreshing every {Math.floor(AUTO_REFRESH_INTERVAL_MS / 1000)}s until{" "}
            {result?.meta.sampleTarget ?? 10}+ total games are available.
          </p>
        ) : null}
      </form>

      {result ? (
        <main className="result-grid">
          <section className="card">
            <div className="title-row">
              <h2>Matchup Difficulty</h2>
              <span
                className="help-chip"
                aria-label="Difficulty scale explanation"
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
              <p className="hint">
                Difficulty score uses weighted lane stats when available (gold diff @15, win rate, early skirmish kills
                minus deaths). Tiers: Easy, Favored, Even, Not Favored, Hard.
              </p>
            ) : null}
            <p className={`difficulty ${result.difficulty}`}>{difficultyLabel(result.difficulty)}</p>
            <p className="meta">
              {result.matchup.playerChampion} vs {result.matchup.enemyChampion} | {result.matchup.lane.toUpperCase()} |{" "}
              {result.matchup.patch}
            </p>
            <p className="meta">
              Win rate: {result.meta.winRate !== null ? `${(result.meta.winRate * 100).toFixed(1)}%` : "N/A"}
            </p>
            {result.matchup.lane === "bot" && result.matchup.playerChampionPartner && result.matchup.enemyChampionPartner ? (
              <p className="meta">
                Duo: {result.matchup.playerChampion} + {result.matchup.playerChampionPartner} vs{" "}
                {result.matchup.enemyChampion} + {result.matchup.enemyChampionPartner}
              </p>
            ) : null}
          </section>

          <section className="card">
            <h2>Early Game Plan (0-5 min)</h2>
            <p>{result.earlyGamePlan}</p>
          </section>

          <section className="card">
            <h2>Level 1-3 Rules</h2>
            <ul>
              {result.level1to3Rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>All-In Windows</h2>
            <ul>
              {result.allInWindows.map((window) => (
                <li key={`${window.timing}-${window.signal}`}>
                  <strong>{timingLabel(window.timing)}:</strong> {window.signal}
                  {!isGenericAllInAction(window.action) ? <> {"->"} {window.action}</> : null}
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Rune Adjustments</h2>
            <p className="hint">Source: {runeSourceLabel(result)}</p>
            {hasRuneAdjustment(result) ? (
              <ul>
                {result.runeAdjustments.keystone.recommended || result.runeAdjustments.keystone.reason ? (
                  <li>
                    <strong>Keystone:</strong> {result.runeAdjustments.keystone.recommended}
                    {result.runeAdjustments.keystone.reason
                      ? ` (${result.runeAdjustments.keystone.reason})`
                      : ""}
                  </li>
                ) : null}
                {result.runeAdjustments.secondary.tree || result.runeAdjustments.secondary.reason ? (
                  <li>
                    <strong>Secondary:</strong> {result.runeAdjustments.secondary.tree}
                    {result.runeAdjustments.secondary.reason
                      ? ` (${result.runeAdjustments.secondary.reason})`
                      : ""}
                  </li>
                ) : null}
                {result.runeAdjustments.shardsNote ? (
                  <li>
                    <strong>Shard note:</strong> {result.runeAdjustments.shardsNote}
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="hint">No rune adjustment suggested for this matchup.</p>
            )}
          </section>

          <section className="card">
            <h2>Common Mistakes</h2>
            <ul>
              {result.commonMistakes.map((mistake) => (
                <li key={mistake}>{mistake}</li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Data Quality</h2>
            <ul>
              <li>
                <strong>Confidence:</strong> {result.meta.dataConfidence}
              </li>
              <li>
                <strong>Sample size:</strong> {result.meta.sampleSize}
              </li>
              <li>
                <strong>Riot games:</strong> {result.meta.providerSamples.riotGames}/{result.meta.sampleTarget}
              </li>
              <li>
                <strong>Lolalytics games:</strong> {result.meta.providerSamples.externalGames}
              </li>
              <li>
                <strong>Effective games:</strong> {result.meta.providerSamples.effectiveGames}
              </li>
              <li>
                <strong>Stats used:</strong> {String(result.meta.source.stats)}
              </li>
              <li>
                <strong>Generated:</strong> {new Date(result.meta.generatedAt).toLocaleString()}
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
