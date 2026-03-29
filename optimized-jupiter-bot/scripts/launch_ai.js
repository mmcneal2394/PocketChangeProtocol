const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');

// Cleanly inject or update GEMINI_API_KEY
if (fs.existsSync(envPath)) {
    let env = fs.readFileSync(envPath, 'utf8');
    const apiKey = 'AIzaSyDJfu4Egz0_TKnuYYoZAkQAKvovABdzoy4';
    if (env.includes('GEMINI_API_KEY=')) {
        env = env.replace(/^GEMINI_API_KEY=.*$/gm, `GEMINI_API_KEY=${apiKey}`);
    } else {
        env += `\nGEMINI_API_KEY=${apiKey}\n`;
    }
    fs.writeFileSync(envPath, env);
    console.log('[AI-LOOP] Injected GEMINI_API_KEY correctly.');
}

function runOptimizerCycle() {
    console.log(`[AI-LOOP] ${new Date().toISOString()} - Starting 10-minute Swarm Refinement (Gemini 2.5)`);
    
    // First run Analyzer (Generates findings.json)
    exec('python3 scripts/maintain/swarm/analyzer_agent.py', { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
        if (err) console.error('[AI-LOOP] Analyzer Error:', err);
        if (stdout) console.log(stdout.trim());
        
        // Then run Critic (Sends to Gemini 2.5, Generates proposals.json)
        exec('python3 scripts/maintain/swarm/critic_agent.py', { cwd: path.join(__dirname, '..') }, (err2, stdout2, stderr2) => {
            if (err2) console.error('[AI-LOOP] Critic Error:', err2);
            if (stdout2) console.log(stdout2.trim());
            
            // Finally, run Auto Apply (Applies proposals.json to strategy_params.json)
            exec('python3 scripts/maintain/swarm/auto_apply_agent.py', { cwd: path.join(__dirname, '..') }, (err3, stdout3, stderr3) => {
                if (err3) console.error('[AI-LOOP] AutoApply Error:', err3);
                if (stdout3) console.log(stdout3.trim());
                console.log(`[AI-LOOP] Cycle complete.`);
            });
        });
    });
}

// Initial Run
runOptimizerCycle();

// 10 minute heartbeat
setInterval(runOptimizerCycle, 10 * 60 * 1000);
