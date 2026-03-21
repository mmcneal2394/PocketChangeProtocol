const { execSync } = require('child_process');
const fs = require('fs');
try {
    const out = execSync('ssh -o StrictHostKeyChecking=no -i C:\\Users\\admin\\.ssh\\do_droplet_key root@64.23.173.160 "tail -n 80 /root/.pm2/logs/jupiter-bot-error.log"');
    fs.writeFileSync('C:\\pcprotocol\\clean_error_log.txt', out);
    console.log("Log saved successfully to clean_log.txt");
} catch (e) {
    console.error(e.message);
}
