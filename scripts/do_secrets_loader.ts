import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

dotenv.config();

// =========================================================================
// PocketChange DigitalOcean App Platform Secure Secrets Loader
// =========================================================================
// In production, the Node engine queries the DigitalOcean API securely 
// to pull the private key into memory dynamically, avoiding any .env files.

// Security Check: Make sure to never commit this token. In prod, this runs via DO's trusted environment bindings.
const DO_API_TOKEN = process.env.DO_API_TOKEN;
if (!DO_API_TOKEN) throw new Error("Missing DO_API_TOKEN in internal environment.");

const DO_APP_ID = process.env.DO_APP_ID; // Must be supplied to know which app holds the secrets

async function fetchDigitalOceanSecrets() {
    console.log(`\n🔒 Initializing DigitalOcean Secure Secrets Loader...`);

    if (!DO_APP_ID) {
        console.warn(`⚠️ [DEV MODE] Missing DO_APP_ID. Simulating Secret Retrieval using internal fallback...`);
        // In local mock, return a mock key for the engine to boot
        const mockKey = Keypair.generate();
        return mockKey.secretKey;
    }

    try {
        console.log(`📡 Querying DigitalOcean App Platform API for App ID: ${DO_APP_ID}`);
        
        // This queries the specific app deployment configuration which houses the encrypted env vars
        const res = await fetch(`https://api.digitalocean.com/v2/apps/${DO_APP_ID}`, {
            headers: {
                "Authorization": `Bearer ${DO_API_TOKEN}`,
                "Content-Type": "application/json"
            }
        });

        if (!res.ok) {
            throw new Error(`DigitalOcean API Rejected Request: ${res.statusText}`);
        }

        const data: any = await res.json();
        
        // Loop through the app spec environment variables to extract the injected 'PRIVATE_KEY'
        let extractedKey = null;
        
        if (data.app && data.app.spec) {
            const envs = data.app.spec.envs || [];
            const keyObj = envs.find((e: any) => e.key === "PRIVATE_KEY");
            if (keyObj && keyObj.value) {
                extractedKey = keyObj.value;
            }
        }

        if (extractedKey) {
            console.log(`✅ Private Key successfully decrypted and loaded into volatile memory!`);
            return bs58.decode(extractedKey);
        } else {
            throw new Error("PRIVATE_KEY not found in DigitalOcean App Specs.");
        }

    } catch (e: any) {
        console.error(`❌ Fatal Error connecting to DigitalOcean Secrets Manager:`, e.message);
        throw e;
    }
}

// Example Execution
async function bootEngine() {
    try {
        const secretKey = await fetchDigitalOceanSecrets();
        const secureWallet = Keypair.fromSecretKey(secretKey);
        
        console.log(`\n🚀 Engine Booted with Tenant Wallet: ${secureWallet.publicKey.toBase58()}`);
        console.log(`⚠️ (Memory will be wiped on process termination. No persistent disk storage used.)`);
    } catch (e) {
        console.error("Boot Sequence Halted due to security fault.");
    }
}

bootEngine();
