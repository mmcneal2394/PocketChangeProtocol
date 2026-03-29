const fs = require('fs');

const envPath = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env';
let env = fs.readFileSync(envPath, 'utf8');

// Replace the value of SNIPER_MIN_5M to 5%
env = env.replace(/^SNIPER_MIN_5M=.*$/m, 'SNIPER_MIN_5M=5');

// Additional tightening criteria, if applicable
env = env.replace(/^SNIPER_MIN_VOL=.*$/m, 'SNIPER_MIN_VOL=5000'); // Increase minimum vol from 1000 to 5000 for safety

fs.writeFileSync(envPath, env);
console.log('Successfully tightened momentum verification parameters.');
