import { FormEvent, useEffect, useMemo, useState } from "react";

type Difficulty = "easy" | "even" | "hard";
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
    source: {
      stats: boolean;
      tags: boolean;
      rag: boolean;
      cacheHit: boolean;
    };
    warnings: string[];
  };
}

interface CacheStatusResponse {
  patch: string;
  lane: CoachLane | "all";
  championsSupported: number | null;
  totalPossiblePairs: number;
  cachedPairs: number;
  freshPairs: number;
  stalePairs: number;
  coveragePct: number;
  latestComputedAt: string | null;
}

interface LlmStatusResponse {
  configured: boolean;
  model?: string;
  modelReachable?: boolean;
  generationAvailable?: boolean;
  status?: "ok" | "quota_exhausted" | "model_not_found" | "network_error" | "api_error";
  message?: string;
  httpStatus?: number;
}

interface CachedPairsResponse {
  patch: string;
  lane?: CoachLane | DataLane | "all";
  count: number;
  pairs: Array<{
    lane?: DataLane;
    playerChampion: string;
    enemyChampion: string;
    fresh: boolean;
  }>;
}

interface CacheStatusByLaneResponse {
  patch: string;
  lanes: Array<{
    lane: DataLane;
    championsInCache: number;
    totalPossiblePairs: number;
    cachedPairs: number;
    freshPairs: number;
    archivedPairs: number;
    coveragePct: number;
    latestComputedAt: string | null;
  }>;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

function difficultyLabel(difficulty: Difficulty): string {
  if (difficulty === "easy") return "Easy";
  if (difficulty === "hard") return "Hard";
  return "Even";
}

function timingLabel(timing: CoachResponse["allInWindows"][number]["timing"]): string {
  return timing.replaceAll("_", " ").replace(/\b\w/g, (s) => s.toUpperCase());
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
  const [coverageRoleFilter, setCoverageRoleFilter] = useState<DataLane | "all">("all");
  const [patch, setPatch] = useState<string>("--");
  const [playerChampion, setPlayerChampion] = useState<string>("");
  const [enemyChampion, setEnemyChampion] = useState<string>("");
  const [playerChampionPartner, setPlayerChampionPartner] = useState<string>("");
  const [enemyChampionPartner, setEnemyChampionPartner] = useState<string>("");
  const [result, setResult] = useState<CoachResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string>("");
  const [submitError, setSubmitError] = useState<string>("");
  const [llmStatus, setLlmStatus] = useState<LlmStatusResponse | null>(null);
  const [cacheStatus, setCacheStatus] = useState<CacheStatusResponse | null>(null);
  const [adminError, setAdminError] = useState<string>("");
  const [adminLoading, setAdminLoading] = useState<boolean>(false);
  const [cachedPairsPrimary, setCachedPairsPrimary] = useState<CachedPairsResponse["pairs"]>([]);
  const [cachedPairsPartner, setCachedPairsPartner] = useState<CachedPairsResponse["pairs"]>([]);
  const [cacheStatusByLane, setCacheStatusByLane] = useState<CacheStatusByLaneResponse["lanes"]>([]);
  const [onlyCachedMatchups, setOnlyCachedMatchups] = useState<boolean>(true);

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

  const refreshAdminDiagnostics = async () => {
    setAdminError("");
    setAdminLoading(true);
    try {
      const [llmRes, cacheRes, cacheByLaneRes] = await Promise.all([
        fetch(`${API_BASE}/api/admin/llm-status`),
        fetch(
          `${API_BASE}/api/admin/cache-status?patch=${encodeURIComponent(patch)}&lane=${encodeURIComponent(selectedLane)}`
        ),
        fetch(`${API_BASE}/api/admin/cache-status-by-lane?patch=${encodeURIComponent(patch)}`)
      ]);
      const pairEndpoints =
        selectedLane === "bot"
          ? [
              `${API_BASE}/api/admin/cached-pairs?patch=${encodeURIComponent(patch)}&lane=adc&freshOnly=true&limit=1000`,
              `${API_BASE}/api/admin/cached-pairs?patch=${encodeURIComponent(patch)}&lane=support&freshOnly=true&limit=1000`
            ]
          : [
              `${API_BASE}/api/admin/cached-pairs?patch=${encodeURIComponent(patch)}&lane=${encodeURIComponent(selectedLane)}&freshOnly=true&limit=1000`
            ];
      const pairResponses = await Promise.all(pairEndpoints.map((url) => fetch(url)));

      const llmPayload = (await llmRes.json()) as LlmStatusResponse;
      const cachePayload = (await cacheRes.json()) as CacheStatusResponse | { error?: string };
      const cacheByLanePayload = (await cacheByLaneRes.json()) as CacheStatusByLaneResponse | { error?: string };
      const pairPayloads = (await Promise.all(
        pairResponses.map((response) => response.json() as Promise<CachedPairsResponse | { error?: string }>)
      )) as Array<CachedPairsResponse | { error?: string }>;

      if (!llmRes.ok) {
        throw new Error(llmPayload?.message ?? `LLM status failed (${llmRes.status})`);
      }
      if (!cacheRes.ok) {
        throw new Error((cachePayload as { error?: string })?.error ?? `Cache status failed (${cacheRes.status})`);
      }
      if (!cacheByLaneRes.ok) {
        throw new Error(
          (cacheByLanePayload as { error?: string })?.error ?? `Cache by lane failed (${cacheByLaneRes.status})`
        );
      }
      const failedPairRes = pairResponses.find((response) => !response.ok);
      if (failedPairRes) {
        const payload = pairPayloads[pairResponses.indexOf(failedPairRes)] as { error?: string };
        throw new Error(payload?.error ?? `Cached pairs failed (${failedPairRes.status})`);
      }

      setLlmStatus(llmPayload);
      setCacheStatus(cachePayload as CacheStatusResponse);
      setCacheStatusByLane((cacheByLanePayload as CacheStatusByLaneResponse).lanes);
      if (selectedLane === "bot") {
        setCachedPairsPrimary((pairPayloads[0] as CachedPairsResponse).pairs);
        setCachedPairsPartner((pairPayloads[1] as CachedPairsResponse).pairs);
      } else {
        setCachedPairsPrimary((pairPayloads[0] as CachedPairsResponse).pairs);
        setCachedPairsPartner([]);
      }
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Failed to load diagnostics.");
    } finally {
      setAdminLoading(false);
    }
  };

  useEffect(() => {
    if (patch === "--") return;
    refreshAdminDiagnostics();
  }, [patch, selectedLane]);

  const filteredLaneCoverage = useMemo(() => {
    if (coverageRoleFilter === "all") return cacheStatusByLane;
    return cacheStatusByLane.filter((entry) => entry.lane === coverageRoleFilter);
  }, [cacheStatusByLane, coverageRoleFilter]);

  const cachedEnemyMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const pair of cachedPairsPrimary) {
      if (!map.has(pair.playerChampion)) map.set(pair.playerChampion, []);
      map.get(pair.playerChampion)!.push(pair.enemyChampion);
    }
    for (const [player, enemies] of map.entries()) {
      map.set(player, [...new Set(enemies)].sort((a, b) => a.localeCompare(b)));
    }
    return map;
  }, [cachedPairsPrimary]);

  const cachedPartnerEnemyMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const pair of cachedPairsPartner) {
      if (!map.has(pair.playerChampion)) map.set(pair.playerChampion, []);
      map.get(pair.playerChampion)!.push(pair.enemyChampion);
    }
    for (const [player, enemies] of map.entries()) {
      map.set(player, [...new Set(enemies)].sort((a, b) => a.localeCompare(b)));
    }
    return map;
  }, [cachedPairsPartner]);

  const enemyOptions = useMemo(() => {
    if (!onlyCachedMatchups) return primaryChampions.filter((champion) => champion !== playerChampion);
    return (cachedEnemyMap.get(playerChampion) ?? []).filter((champion) => champion !== playerChampion);
  }, [onlyCachedMatchups, primaryChampions, playerChampion, cachedEnemyMap]);

  const enemyPartnerOptions = useMemo(() => {
    if (selectedLane !== "bot") return [];
    if (!onlyCachedMatchups) return partnerChampions.filter((champion) => champion !== playerChampionPartner);
    return (cachedPartnerEnemyMap.get(playerChampionPartner) ?? []).filter(
      (champion) => champion !== playerChampionPartner
    );
  }, [selectedLane, onlyCachedMatchups, partnerChampions, playerChampionPartner, cachedPartnerEnemyMap]);

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

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
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
  };

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

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={onlyCachedMatchups}
            onChange={(e) => setOnlyCachedMatchups(e.target.checked)}
          />
          <span>Only show cached matchups ({enemyOptions.length} options)</span>
        </label>

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
        {!loadError && onlyCachedMatchups && enemyOptions.length === 0 ? (
          <p className="hint">No cached enemy matchup found for this champion yet.</p>
        ) : null}
        {!loadError && onlyCachedMatchups && selectedLane === "bot" && enemyPartnerOptions.length === 0 ? (
          <p className="hint">No cached enemy support matchup found for this duo yet.</p>
        ) : null}
      </form>

      {result ? (
        <main className="result-grid">
          <section className="card">
            <h2>Matchup Difficulty</h2>
            <p className={`difficulty ${result.difficulty}`}>{difficultyLabel(result.difficulty)}</p>
            <p className="meta">
              {result.matchup.playerChampion} vs {result.matchup.enemyChampion} | {result.matchup.lane.toUpperCase()} |{" "}
              {result.matchup.patch}
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
                  <strong>{timingLabel(window.timing)}:</strong> {window.signal} {"->"} {window.action}
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

      <section className="card admin-panel">
        <div className="admin-header">
          <h2>Admin Diagnostics</h2>
          <button type="button" onClick={refreshAdminDiagnostics} disabled={adminLoading}>
            {adminLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {adminError ? <p className="error">{adminError}</p> : null}

        <div className="result-grid">
          <section className="card">
            <h2>Gemini Status</h2>
            {llmStatus ? (
              <ul>
                <li>
                  <strong>Configured:</strong> {String(llmStatus.configured)}
                </li>
                <li>
                  <strong>Model:</strong> {llmStatus.model ?? "-"}
                </li>
                <li>
                  <strong>Reachable:</strong> {String(llmStatus.modelReachable ?? false)}
                </li>
                <li>
                  <strong>Generation available:</strong> {String(llmStatus.generationAvailable ?? false)}
                </li>
                <li>
                  <strong>Status:</strong> {llmStatus.status ?? "-"}
                </li>
              </ul>
            ) : (
              <p className="hint">No status data yet.</p>
            )}
            {llmStatus?.message ? <p className="hint">{llmStatus.message}</p> : null}
          </section>

          <section className="card">
            <h2>Cache Status</h2>
            {cacheStatus ? (
              <ul>
                <li>
                  <strong>Patch:</strong> {cacheStatus.patch}
                </li>
                <li>
                  <strong>Coverage:</strong> {cacheStatus.coveragePct}%
                </li>
                <li>
                  <strong>Fresh pairs:</strong> {cacheStatus.freshPairs}
                </li>
                <li>
                  <strong>Cached pairs:</strong> {cacheStatus.cachedPairs}/{cacheStatus.totalPossiblePairs}
                </li>
                <li>
                  <strong>Latest compute:</strong>{" "}
                  {cacheStatus.latestComputedAt ? new Date(cacheStatus.latestComputedAt).toLocaleString() : "-"}
                </li>
              </ul>
            ) : (
              <p className="hint">No cache data yet.</p>
            )}
          </section>
        </div>

        <section className="card lane-coverage-card">
          <div className="admin-header">
            <h2>Lane Coverage</h2>
            <label>
              Role filter
              <select
                value={coverageRoleFilter}
                  onChange={(e) => setCoverageRoleFilter(e.target.value as DataLane | "all")}
              >
                <option value="all">All</option>
                <option value="top">Top</option>
                <option value="jungle">Jungle</option>
                <option value="mid">Mid</option>
                <option value="adc">ADC</option>
                <option value="support">Support</option>
              </select>
            </label>
          </div>
          {filteredLaneCoverage.length > 0 ? (
            <div className="lane-coverage-table">
              {filteredLaneCoverage.map((entry) => (
                <div key={entry.lane} className="lane-row">
                  <div className="lane-row-header">
                    <strong>{entry.lane.toUpperCase()}</strong>
                    <span>
                      {entry.cachedPairs}/{entry.totalPossiblePairs} ({entry.coveragePct}%)
                    </span>
                  </div>
                  <div className="lane-bar-track">
                    <div className="lane-bar-fill" style={{ width: `${Math.min(100, Math.max(0, entry.coveragePct))}%` }} />
                  </div>
                  <p className="hint lane-row-meta">
                    champs: {entry.championsInCache} | fresh: {entry.freshPairs} | archived: {entry.archivedPairs} |
                    latest: {entry.latestComputedAt ? new Date(entry.latestComputedAt).toLocaleString() : "-"}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">No lane coverage data yet.</p>
          )}
        </section>
      </section>
    </div>
  );
}
