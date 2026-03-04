
import { getDatabase } from "./src/db/sqlite.js";

async function run() {
    const db = await getDatabase("./data/matchup-coach.db");
    const row = await db.get("SELECT sql FROM sqlite_master WHERE name = 'matchup_stats_cache'");
    console.log("SCHEMA_START");
    console.log(row.sql);
    console.log("SCHEMA_END");

    const patches = await db.all("SELECT DISTINCT patch FROM matchup_stats_cache");
    for (const p of patches) {
        console.log(`PATCH_START|${typeof p.patch}|${p.patch.length}|${JSON.stringify(p.patch)}|PATCH_END`);
    }
}

run().catch(console.error);
