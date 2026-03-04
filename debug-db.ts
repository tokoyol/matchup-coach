
import { getDatabase } from "./src/db/sqlite.js";
import { MatchupStatsRepository } from "./src/services/matchupStatsRepository.js";
import { env } from "./src/config/env.js";

async function run() {
    console.log("Environment Patch:", env.CURRENT_PATCH);
    const db = await getDatabase(env.STATS_DB_PATH);
    const repo = new MatchupStatsRepository(db);

    const patches = await db.all("SELECT patch, COUNT(*) as count FROM matchup_stats_cache GROUP BY patch");
    console.log("Database Content (Patches):", JSON.stringify(patches, null, 2));

    const lanes = ["top", "jungle", "mid", "adc", "support"];
    for (const lane of lanes) {
        const champs = await repo.listChampionsByLane(env.CURRENT_PATCH, lane as any, 10);
        console.log(`Champs for ${lane} on ${env.CURRENT_PATCH}:`, champs.length);
    }

    // Check fallback patch
    const match = /^(\d{2})\.(\d{1,2})$/.exec(env.CURRENT_PATCH.trim());
    if (match) {
        const prev = `${match[1]}.${Number(match[2]) - 1}`;
        console.log("Previous Patch Check:", prev);
        for (const lane of lanes) {
            const champs = await repo.listChampionsByLane(prev, lane as any, 10);
            console.log(`Champs for ${lane} on ${prev}:`, champs.length);
        }
    }
}

run().catch(console.error);
