
async function run() {
    const resp = await fetch("http://localhost:4000/api/champions?lane=top");
    const data = await resp.json();
    console.log("RESULT_START");
    console.log("Patch:", data.patch);
    console.log("Champions Count:", data.champions.length);
    console.log("RESULT_END");
}
run();
