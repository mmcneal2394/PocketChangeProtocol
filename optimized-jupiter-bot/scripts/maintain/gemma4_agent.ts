// gemma4_agent.ts — Changed to ultra-lightweight llama3.2:1b to prevent local freezing
import * as http from 'http';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

function ollamaChat(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: 'llama3.2:1b',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/chat',
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
