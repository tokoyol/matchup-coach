
import { getDatabase } from "./src/db/sqlite.js";

async function run() {
    const db = await getDatabase("./data/matchup-coach.db");
    const patch = "26.4";
    const lane = "top";

    const query = `
    SELECT player_champion AS champion
    FROM matchup_stats_cache
    WHERE patch = ? AND lane = ?
    UNION
    SELECT enemy_champion AS champion
    FROM matchup_stats_cache
    WHERE patch = ? AND lane = ?
    LIMIT ?
  `;

    const rows = await db.all(query, [patch, lane, patch, lane, 10]);
    console.log("RAW_ROWS_START");
    console.log(JSON.stringify(rows));
    console.log("RAW_ROWS_END");

    const simple = await db.all("SELECT player_champion FROM matchup_stats_cache WHERE patch = '26.4' AND lane = 'top' LIMIT 5");
    console.log("SIMPLE_ROWS:", JSON.stringify(simple));
}

run().catch(console.error);
