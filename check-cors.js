
async function run() {
    try {
        const resp = await fetch("http://localhost:4000/api/config", {
            headers: {
                "Origin": "http://localhost:5173"
            }
        });
        console.log("CORS_CHECK_START");
        console.log("Status:", resp.status);
        console.log("Header allow-origin:", resp.headers.get("access-control-allow-origin"));
        console.log("CORS_CHECK_END");
    } catch (err) {
        console.error("Fetch failed:", err.message);
    }
}
run();
