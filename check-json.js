
async function run() {
    const resp = await fetch("http://localhost:4000/api/champions?lane=top");
    const data = await resp.json();
    console.log("CHAMPIONS_JSON_START");
    console.log(JSON.stringify(data));
    console.log("CHAMPIONS_JSON_END");
}
run();
