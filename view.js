const { execSync } = require('child_process'); 
const out = execSync('ssh -o StrictHostKeyChecking=no -i C:\\Users\\admin\\.ssh\\do_droplet_key root@64.23.173.160 "tail -n 120 /root/.pm2/logs/jupiter-bot-out.log"'); 
require('fs').writeFileSync('C:\\pcprotocol\\view.txt', out);
