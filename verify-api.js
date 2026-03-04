
import fetch from "node-fetch";

async function run() {
    try {
        const response = await fetch("http://localhost:4000/api/champions?lane=top");
        const data = await response.json();
        console.log("API Response Patch:", data.patch);
        console.log("Champions Found:", data.champions.length);
    } catch (err) {
        console.error("Fetch failed (server might be down):", err.message);
    }
}

run().catch(console.error);
