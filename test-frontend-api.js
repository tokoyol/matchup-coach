
async function run() {
    const base = "http://localhost:4000/api";
    const endpoints = [
        "/config",
        "/champions?lane=top",
        "/champion-metadata"
    ];

    for (const ep of endpoints) {
        try {
            const resp = await fetch(base + ep);
            const data = await resp.json();
            console.log(`ENDPOINT: ${ep}`);
            console.log(JSON.stringify(data).slice(0, 200));
            console.log("-------------------");
        } catch (err) {
            console.error(`FAILED: ${ep}`, err.message);
        }
    }
}
run();
