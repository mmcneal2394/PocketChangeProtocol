import express from 'express';
import cron from 'node-cron';
import cors from 'cors';
import { runViralExtraction } from './scripts/maintain/deployer_meta_extractor';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the UI from /public folder

// State Management
let autoPilotEnabled = false;
let autoPilotTask: any = null;
let lastLaunch: any = null;
const LAUNCH_LOGS: string[] = [];

// Overload console.log so we can pipe output to the UI dashboard terminal
const originalLog = console.log;
console.log = function (...args) {
    LAUNCH_LOGS.push(args.join(' '));
    // Keep only last 50 lines to prevent memory leaks
    if (LAUNCH_LOGS.length > 50) LAUNCH_LOGS.shift();
    originalLog.apply(console, args);
};

console.log("=== THE ANTIGRAVITY TRAP NETWORK ===");
console.log("[SERVER] Booting interface...");

// ── 1. API: System Status ──────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({
         autoPilotEnabled,
         lastLaunch,
         logs: LAUNCH_LOGS
    });
});

// ── 2. API: Manual Deployment Override ─────────────────────────────────────
app.post('/api/deploy/manual', async (req, res) => {
    try {
         console.log("\n[API] ⚡ MANUAL OVERRIDE INITIATED. Triggering extraction pipeline...");
         // Start async, don't wait for completion to free up HTTP thread
         runViralExtraction(0.00, 5, 0.005)
            .then(() => {
                lastLaunch = { time: new Date(), type: 'Manual' };
                console.log("[API] ✅ Manual Extraction Pipeline Completed.");
            })
            .catch(console.error);
            
         res.json({ status: "success", message: "Deployment sequence ignited." });
    } catch (e: any) {
         res.status(500).json({ error: e.message });
    }
});

// ── 3. API: Toggle Auto-Pilot (Cron Scheduling) ────────────────────────────
app.post('/api/schedule/toggle', (req, res) => {
    autoPilotEnabled = !autoPilotEnabled;
    
    if (autoPilotEnabled) {
         console.log("\n[CRON] 🌐 AUTO-PILOT ACTIVATED.");
         console.log("[CRON] The Swarm will now autonomously launch viral tokens every 4 hours.");
         
         autoPilotTask = cron.schedule('0 */4 * * *', async () => {
             console.log(`\n[CRON] ⏰ SCHEDULED WAKE - Executing Autonomous Deploy Protocol...`);
             try {
                  await runViralExtraction(0.00, 5, 0.005);
                  lastLaunch = { time: new Date(), type: 'Autonomous' };
                  console.log(`[CRON] ✅ Scheduled extraction successful. Entering 4 hour hibernate.`);
             } catch (e) {
                  console.error(`[CRON] ❌ Scheduled execution failed:`, e);
             }
         });
    } else {
         console.log("\n[CRON] 🛑 AUTO-PILOT DEACTIVATED.");
         if (autoPilotTask) autoPilotTask.stop();
    }
    
    res.json({ status: "success", autoPilotEnabled });
});

// ── 4. Start Server ────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[SERVER] ✅ Trap Network listening on http://localhost:${PORT}`);
});
