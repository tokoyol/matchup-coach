
import { getDatabase } from "./src/db/sqlite.js";

async function run() {
    const db = await getDatabase("./data/matchup-coach.db");
    const row = await db.get("SELECT expires_at FROM matchup_stats_cache LIMIT 1");
    console.log("Sample expires_at:", row.expires_at);
    console.log("Current time:", Date.now());
    console.log("Is expired?", row.expires_at <= Date.now());
}

run().catch(console.error);
