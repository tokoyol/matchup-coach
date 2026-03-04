
import { getDatabase } from "./src/db/sqlite.js";

async function run() {
    const db = await getDatabase("./data/matchup-coach.db");
    const lanes = await db.all("SELECT DISTINCT lane FROM matchup_stats_cache");
    for (const l of lanes) {
        console.log(`LANE_START|${typeof l.lane}|${l.lane.length}|${JSON.stringify(l.lane)}|LANE_END`);
    }
}

run().catch(console.error);
