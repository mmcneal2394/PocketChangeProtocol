const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const DROPLET_IP = '64.23.173.160';
const DROPLET_USER = 'root';
const REMOTE_DIR = '/opt/pcprotocol';

// Directories to watch
const WATCH_DIRS = [
    path.join(__dirname, '..', 'scripts'),
    path.join(__dirname, '..', 'engine-worker', 'src'),
    path.join(__dirname, '..', 'src', 'app'),
    path.join(__dirname, '..', 'src', 'components')
];

let isSyncing = false;
let syncTimeout = null;

const syncToDroplet = () => {
    if (isSyncing) return;
    isSyncing = true;
    
    console.log(`\n[Watchdog] 🔄 Pushing updates to ${DROPLET_USER}@${DROPLET_IP}:${REMOTE_DIR}...`);

    // Using scp recursively (Requires SSH keys to be set up)
    const scpCommand = `scp -r ../scripts ../engine-worker ../src ../package.json ../docker-compose.yml ${DROPLET_USER}@${DROPLET_IP}:${REMOTE_DIR}`;

    exec(scpCommand, (error, stdout, stderr) => {
        if (error) {
            console.error(`[Watchdog] ❌ Sync failed: ${error.message}`);
            isSyncing = false;
            return;
        }
        
        console.log(`[Watchdog] ✅ Sync complete. Triggering remote Docker restart...`);
        
        // Remote Command to restart the containers
        const sshCommand = `ssh ${DROPLET_USER}@${DROPLET_IP} "cd ${REMOTE_DIR} && docker-compose build && docker-compose up -d"`;
        
        exec(sshCommand, (sshErr, sshStdout, sshStderr) => {
             if (sshErr) {
                 console.error(`[Watchdog] ❌ Remote restart failed: ${sshErr.message}`);
             } else {
                 console.log(`[Watchdog] 🚀 Remote containers rebuilt and restarted successfully.`);
             }
             isSyncing = false;
        });
    });
};

const handleFileChange = (eventType, filename) => {
    if (!filename || filename.endsWith('.jsonl') || filename.includes('node_modules')) return;
    
    // Debounce to prevent multiple triggers for a single save
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        console.log(`\n[Watchdog] 📝 Detected ${eventType} in ${filename}`);
        syncToDroplet();
    }, 1500);
};

console.log(`\n[Watchdog] 👁️  Initializing Local CI/CD Pipeline...`);
console.log(`[Watchdog] Target: ${DROPLET_USER}@${DROPLET_IP}`);

WATCH_DIRS.forEach(dir => {
    if (fs.existsSync(dir)) {
        console.log(`[Watchdog] Watching directory: ${dir}`);
        fs.watch(dir, { recursive: true }, handleFileChange);
    } else {
        console.log(`[Watchdog] ⚠️ Directory does not exist: ${dir}`);
    }
});
