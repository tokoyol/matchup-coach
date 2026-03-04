
import { getDatabase } from "./src/db/sqlite.js";

async function run() {
    const db = await getDatabase("./data/matchup-coach.db");
    const schema = await db.get("SELECT sql FROM sqlite_master WHERE name = 'matchup_stats_cache'");
    console.log("Schema:", schema.sql);

    const rawPatch = await db.get("SELECT DISTINCT patch FROM matchup_stats_cache LIMIT 1");
    console.log("Raw Patch:", JSON.stringify(rawPatch.patch));
    console.log("Raw Patch Type:", typeof rawPatch.patch);
    console.log("Raw Patch Length:", rawPatch.patch.length);
}

run().catch(console.error);
