// gemma4_agent.ts
import * as http from 'http';
import * as https from 'https';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const OLLAMA_MODEL = process.env.GEMMA4_MODEL || process.env.OLLAMA_MODEL || 'dmind-risk';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';

function ollamaChat(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL(OLLAMA_URL);
    const transport = target.protocol === 'https:' ? https : http;
    const postData = JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });

    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 600_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.message?.content || '(empty response)');
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timed out')); });
    req.write(postData);
    req.end();
  });
}

export async function runAgent(userPrompt: string): Promise<string | null> {
  try {
    console.log(`[AGENT] Using Ollama model: ${OLLAMA_MODEL} @ ${OLLAMA_URL}`);
    const content = await ollamaChat(userPrompt);
    console.log('[AGENT] Native Response:\n', content);
    return content;
  } catch (e: any) {
    console.error(`[AGENT] Ollama integration error: ${e.message}`);
    return null;
  }
}

// Standalone test
if (require.main === module) {
  runAgent('Say OK if you are online.').then(console.log);
}
