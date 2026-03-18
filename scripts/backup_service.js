const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipe = promisify(pipeline);

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MAX_RETENTION_DAYS = 7;
const BACKUP_INTERVAL_MS = 1000 * 60 * 60 * 12; // 12 hours

// Critical files to backup
const FILES_TO_BACKUP = [
    'dev.db',
    'trades.json',
    'tx_details.json',
    'loss_logs.json',
    '.env'
];

async function createBackup() {
    console.log(`[Backup Service] Initiating snapshot...`);
    
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    try {
        for (const file of FILES_TO_BACKUP) {
            const sourcePath = path.join(__dirname, '..', file);
            if (!fs.existsSync(sourcePath)) {
                console.warn(`[Backup Service] Warning: ${file} not found. Skipping.`);
                continue;
            }

            const destPath = path.join(BACKUP_DIR, `${file}.${timestamp}.gz`);
            
            const gzip = zlib.createGzip();
            const source = fs.createReadStream(sourcePath);
            const destination = fs.createWriteStream(destPath);
            
            await pipe(source, gzip, destination);
            console.log(`[Backup Service] Successfully archived ${file} -> ${destPath}`);
        }
    } catch (err) {
        console.error(`[Backup Service] Error creating backup:`, err);
    }
}

function cleanOldBackups() {
    console.log(`[Backup Service] Purging archives older than ${MAX_RETENTION_DAYS} days...`);
    
    if (!fs.existsSync(BACKUP_DIR)) return;

    const files = fs.readdirSync(BACKUP_DIR);
    const now = Date.now();
    const maxAgeMs = MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
        const filePath = path.join(BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            console.log(`[Backup Service] Deleted stale backup: ${file}`);
        }
    }
}

async function run() {
    console.log("[Backup Service] Daemon started.");
    
    // Check if running in manual mode (e.g. `npm run backup:now`)
    if (process.argv.includes('--manual')) {
        await createBackup();
        cleanOldBackups();
        console.log("[Backup Service] Manual snapshot complete. Exiting.");
        process.exit(0);
    }

    // First run on boot
    await createBackup();
    cleanOldBackups();

    // Schedule regular backups
    setInterval(async () => {
        await createBackup();
        cleanOldBackups();
    }, BACKUP_INTERVAL_MS);
}

run();
