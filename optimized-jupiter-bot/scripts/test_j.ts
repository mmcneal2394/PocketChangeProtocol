import fetch from 'node-fetch';

async function run() {
    try {
        const payload = {
            jsonrpc: "2.0",
            id: 1,
            method: "getTipAccounts",
            params: []
        };
        const response = await fetch("https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        console.log("Active Jito Tip Accounts:");
        console.log(data);
    } catch (e) {
        console.error(e);
    }
}
run();
