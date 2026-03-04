
import { getDatabase } from "./src/db/sqlite.js";

async function run() {
    const db = await getDatabase("./data/matchup-coach.db");
    const stats = await db.all("SELECT patch, lane, COUNT(*) as count FROM matchup_stats_cache GROUP BY patch, lane");
    console.log("FINAL_DUMP_START");
    console.log(JSON.stringify(stats, null, 2));
    console.log("FINAL_DUMP_END");
}

run().catch(console.error);
