
import sqlite3 from "sqlite3";

const db = new sqlite3.Database("./data/matchup-coach.db");

db.all("SELECT patch, lane, COUNT(*) as count FROM matchup_stats_cache GROUP BY patch, lane", (err, rows) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log("DB_AUDIT_START");
    console.log(JSON.stringify(rows, null, 2));
    console.log("DB_AUDIT_END");
    db.close();
});
