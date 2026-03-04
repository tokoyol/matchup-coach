
import { getDatabase } from "./src/db/sqlite.js";

async function run() {
    const db = await getDatabase("./data/matchup-coach.db");
    const pairs = await db.all("SELECT DISTINCT patch, lane, COUNT(*) as count FROM matchup_stats_cache GROUP BY patch, lane");
    console.log("PAIRS_START");
    console.log(JSON.stringify(pairs, null, 2));
    console.log("PAIRS_END");
}

run().catch(console.error);
