
async function run() {
    const base = "http://localhost:4000/api";
    const lanes = ["top", "jungle", "mid", "adc", "support"];

    for (const lane of lanes) {
        try {
            const resp = await fetch(`${base}/champions?lane=${lane}`);
            const data = await resp.json();
            console.log(`LANE: ${lane}, COUNT: ${data.champions?.length}, PATCH: ${data.patch}`);
        } catch (err) {
            console.error(`FAILED: ${lane}`, err.message);
        }
    }
}
run();
