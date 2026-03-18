const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const logDir = path.join('C:\\pcprotocol', 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

function startLogTail() {
    console.log('Starting remote log tail...');
    
    // Create an ISO string for rolling periods (by day)
    const dateStr = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `remote_transactions_${dateStr}.log`);
    
    // Tail the engine docker logs and pipe to our local file
    const tailProcess = exec('ssh root@64.23.173.160 "cd /opt/pcprotocol ; docker-compose logs --tail=100 -f engine"');
    
    const writeStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    tailProcess.stdout.on('data', (data) => {
        // format output
        const lines = data.split('\n');
        for (const line of lines) {
            if (line.trim().length > 0) {
                // Log anything relevant to the testing
                if (line.includes('Live Transaction') || line.includes('MULTIPATH ARB') || line.includes('Speed Test') || line.includes('Helius') || line.includes('Failed') || line.includes('Yield gap')) {
                    const out = new Date().toISOString() + ' ' + line.replace('pcp-rust-engine | ', '').trim() + '\n';
                    writeStream.write(out);
                    
                    // only output Helius lines to local console so it isn't noisy
                    if (line.includes('Helius Sender') || line.includes('Live Fast-Track Executed')) {
                        console.log(out.trim());
                    }
                }
            }
        }
    });

    tailProcess.stderr.on('data', (data) => {
        // console.error('Tail stderr: ' + data);
    });

    tailProcess.on('close', (code) => {
        console.log('Tail closed with code ' + code + '. Restarting in 5s...');
        writeStream.close();
        setTimeout(startLogTail, 5000);
    });
}

startLogTail();
