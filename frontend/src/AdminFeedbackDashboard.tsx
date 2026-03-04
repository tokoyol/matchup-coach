import { useEffect, useState } from "react";
import { API_BASE } from "./App";
import { COPY } from "./i18n";

interface FeedbackRow {
    id: number | string;
    patch: string;
    lane: string;
    playerChampion: string;
    enemyChampion: string;
    rating: "good" | "bad";
    comment?: string;
    createdAt: string;
}

export function AdminFeedbackDashboard() {
    const [language] = useState<"en" | "ja">(() => {
        const saved = localStorage.getItem("app_language");
        return (saved === "ja" || saved === "en") ? saved : "en";
    });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<FeedbackRow[]>([]);

    const copy = COPY[language];

    useEffect(() => {
        let active = true;
        const fetchFeedback = async () => {
            try {
                const response = await fetch(`${API_BASE}/api/admin/feedback`);
                const payload = await response.json();

                if (!response.ok) {
                    throw new Error(payload?.error || `Request failed with status ${response.status}`);
                }

                if (active) {
                    setFeedback(payload.feedback || []);
                    setError(null);
                }
            } catch (err) {
                if (active) {
                    setError(err instanceof Error ? err.message : "Failed to load feedback");
                }
            } finally {
                if (active) setLoading(false);
            }
        };

        void fetchFeedback();
        return () => { active = false; };
    }, []);

    if (loading) {
        return (
            <div className="page" style={{ padding: "2rem", display: "flex", justifyContent: "center" }}>
                <p className="hint">Loading feedback data...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="page" style={{ padding: "2rem" }}>
                <h1 style={{ color: "var(--danger)" }}>Access Denied or Error</h1>
                <p>{error}</p>
                <p className="hint" style={{ marginTop: "1rem" }}>
                    <a href="#/" style={{ color: "var(--primary)" }}>← Return to app</a>
                </p>
            </div>
        );
    }

    return (
        <div className="page" style={{ padding: "2rem", maxWidth: "1000px", margin: "0 auto" }}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
                <h1>Feedback Dashboard</h1>
                <a href="#/" style={{ color: "var(--primary)", textDecoration: "none", fontWeight: 500 }}>
                    ← Back to Coach
                </a>
            </header>

            {feedback.length === 0 ? (
                <div className="card" style={{ textAlign: "center", padding: "3rem 1rem" }}>
                    <p className="hint" style={{ fontSize: "1.2rem" }}>No feedback collected yet.</p>
                </div>
            ) : (
                <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                        <thead>
                            <tr style={{ borderBottom: "1px solid var(--border)", backgroundColor: "var(--bg-layer1)" }}>
                                <th style={{ padding: "1rem" }}>Date</th>
                                <th style={{ padding: "1rem" }}>{copy.app.patch.replace(" {patch}", "")}</th>
                                <th style={{ padding: "1rem" }}>{copy.form.lane}</th>
                                <th style={{ padding: "1rem" }}>Matchup (Player vs Enemy)</th>
                                <th style={{ padding: "1rem" }}>Rating</th>
                                <th style={{ padding: "1rem" }}>Comment</th>
                            </tr>
                        </thead>
                        <tbody>
                            {feedback.map((row) => (
                                <tr key={row.id} style={{ borderBottom: "1px solid var(--border)" }}>
                                    <td style={{ padding: "1rem", color: "var(--text-dim)" }}>
                                        {new Date(row.createdAt).toLocaleString(undefined, {
                                            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                                        })}
                                    </td>
                                    <td style={{ padding: "1rem" }}>{row.patch}</td>
                                    <td style={{ padding: "1rem", textTransform: "capitalize" }}>{row.lane}</td>
                                    <td style={{ padding: "1rem" }}>
                                        <strong>{row.playerChampion}</strong>
                                        <span style={{ color: "var(--text-dim)", margin: "0 0.5rem" }}>vs</span>
                                        <strong>{row.enemyChampion}</strong>
                                    </td>
                                    <td style={{ padding: "1rem", fontSize: "1.2rem" }}>
                                        {row.rating === "good" ? "👍" : "👎"}
                                    </td>
                                    <td style={{ padding: "1rem", color: "var(--text-dim)", maxWidth: "300px", fontSize: "0.9rem" }}>
                                        {row.comment || "-"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
