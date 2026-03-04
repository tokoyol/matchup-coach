
import { getDatabase } from "./src/db/sqlite.js";
import { MatchupStatsRepository } from "./src/services/matchupStatsRepository.js";
import { env } from "./src/config/env.js";

async function run() {
    const db = await getDatabase(env.STATS_DB_PATH);
    const repo = new MatchupStatsRepository(db);

    const patches = await db.all("SELECT patch, COUNT(*) as count FROM matchup_stats_cache GROUP BY patch");
    console.log("Patches in DB:", patches);

    const topChamps = await repo.listChampionsByLane("26.4", "top", 100);
    console.log("Top Champions for 26.4:", topChamps.length);

    const topChampsCurrent = await repo.listChampionsByLane("26.5", "top", 100);
    console.log("Top Champions for 26.5:", topChampsCurrent.length);
}

run().catch(console.error);
