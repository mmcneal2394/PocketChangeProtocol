const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const DROPLET_IP = '64.23.173.160';

// Read the public key from the standard Windows path
const pubKeyPath = path.join(process.env.USERPROFILE, '.ssh', 'id_ed25519.pub');
let pubKey = '';
try {
    pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
    console.log(`🔑 Loaded public key: ${pubKey.substring(0, 30)}...`);
} catch (e) {
    console.error(`❌ Could not read public key at ${pubKeyPath}. Ensure it exists.`, e.message);
    process.exit(1);
}

// User indicated we should ask for the password via the implementation plan, but we're automating this.
// Assuming the user has the password or we can prompt for it if needed, but since we are an automated agent,
// we will try to connect using the existing private key first. If that fails, it means the key isn't on the server.
console.log(`Attempting to inject key into ${DROPLET_IP}...`);

// Read the private key
const privKeyPath = path.join(process.env.USERPROFILE, '.ssh', 'id_ed25519');
let privKey = '';
try {
    privKey = fs.readFileSync(privKeyPath, 'utf8');
} catch (e) {
    console.error(`❌ Could not read private key at ${privKeyPath}.`, e.message);
    process.exit(1);
}

// First, check if passwordless auth ALREADY works
const testConn = new Client();
testConn.on('ready', () => {
    console.log('✅ Passwordless SSH authentication is ALREADY WORKING!');
    testConn.end();
    process.exit(0);
}).on('error', (err) => {
    console.log(`⚠️ Passwordless auth failed (${err.message}). We need the root password to inject the key.`);
    console.log(`Please run the ssh-copy-id equivalent manually or provide the password to this script.`);
    process.exit(1);
}).connect({
    host: DROPLET_IP,
    port: 22,
    username: 'root',
    privateKey: privKey
});
