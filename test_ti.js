async function run() {
    try {
        const response = await fetch("https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] })
        });
        const text = await response.text();
        const fs = require('fs');
        fs.writeFileSync('tip_accounts.json', text);
        console.log("Tip accounts fetched.");
    } catch (e) {
        console.error(e);
    }
}
run();
