
import { getDatabase } from "./src/db/sqlite.js";
import { env } from "./src/config/env.js";

async function run() {
    const db = await getDatabase(env.STATS_DB_PATH);

    const lanesInDb = await db.all("SELECT DISTINCT lane FROM matchup_stats_cache");
    console.log("Lanes in DB:", JSON.stringify(lanesInDb, null, 2));

    const sampleRows = await db.all("SELECT patch, lane, player_champion, enemy_champion FROM matchup_stats_cache LIMIT 5");
    console.log("Sample rows:", JSON.stringify(sampleRows, null, 2));

    const countBot = await db.get("SELECT COUNT(*) as count FROM matchup_stats_cache WHERE lane = 'bot'");
    console.log("Count for lane='bot':", countBot.count);
}

run().catch(console.error);
