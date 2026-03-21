const { execSync } = require('child_process'); 
const out = execSync('ssh -o StrictHostKeyChecking=no -i C:\\Users\\admin\\.ssh\\do_droplet_key root@64.23.173.160 "cat /root/.pm2/logs/jupiter-bot-out.log"'); 
require('fs').writeFileSync('C:\\pcprotocol\\full_out.txt', out);
