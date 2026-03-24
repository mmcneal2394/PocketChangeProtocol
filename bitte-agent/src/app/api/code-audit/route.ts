import { NextRequest, NextResponse } from 'next/server';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const TS_PATTERNS = [
  { id: 'TS-001', category: 'Private Key Exposure',         severity: 'CRITICAL', pattern: /(secretKey|fromSecretKey|PRIVATE_KEY)\s*[=:]\s*['"]?[A-Za-z0-9+/]{40,}/i,        message: 'Hardcoded private key detected',              remediation: 'Load from env: process.env.WALLET_KEYPAIR_PATH — never hardcode' },
  { id: 'TS-002', category: 'API Key Exposure',             severity: 'HIGH',     pattern: /(api[_-]?key|apiKey|bearer)\s*[=:]\s*['"][A-Za-z0-9_\-\.]{20,}['"]/i,             message: 'Hardcoded API key or token',                  remediation: 'Use process.env.YOUR_API_KEY and add to .gitignore' },
  { id: 'TS-003', category: 'Missing Slippage Protection',  severity: 'HIGH',     pattern: /swap|swapTransaction|executeSwap/i,                                                  message: 'Swap call — verify slippageBps is set',       remediation: 'Always pass slippageBps: { slippageBps: 50 }' },
  { id: 'TS-004', category: 'No Transaction Simulation',    severity: 'MEDIUM',   pattern: /sendTransaction|sendRawTransaction/i,                                                message: 'Tx sent without simulation check',            remediation: 'Call simulateTransaction() first and check for err' },
  { id: 'TS-005', category: 'Unbounded Retry Loop',         severity: 'MEDIUM',   pattern: /while\s*\(\s*true\s*\)/i,                                                           message: 'Infinite loop — may hang on RPC failure',    remediation: 'Add max attempts counter: let attempts = 0; while(attempts++ < MAX_RETRY)' },
  { id: 'TS-006', category: 'Console Log of Sensitive Data',severity: 'HIGH',     pattern: /console\.(log|warn|error)\s*\(.*?(keypair|secretKey|privateKey)/i,                  message: 'Logging sensitive key material',              remediation: 'Log only publicKey.toBase58() — never the keypair object' },
  { id: 'TS-007', category: 'Missing RPC Error Handling',   severity: 'LOW',      pattern: /await connection\.(getBalance|getAccountInfo|getTransaction)\s*\([^)]+\)\s*;/i,     message: 'RPC call without try/catch',                  remediation: 'Wrap in try/catch to handle network failures gracefully' },
];

const RS_PATTERNS = [
  { id: 'RS-001', category: 'Integer Overflow Risk',   severity: 'MEDIUM',   pattern: /\w+\s*\+\s*\w+|\w+\s*\*\s*\w+/,                                   message: 'Unchecked arithmetic — may overflow',          remediation: 'Use checked_add() / checked_mul() with ? operator' },
  { id: 'RS-002', category: 'Missing Signer Check',    severity: 'CRITICAL', pattern: /pub\s+fn\s+\w+\s*\(/,                                              message: 'Instruction — verify signer constraint exists', remediation: 'Add #[account(signer)] or validate .is_signer == true' },
  { id: 'RS-003', category: 'Arbitrary CPI',           severity: 'HIGH',     pattern: /invoke\s*\(&Instruction/,                                          message: 'CPI with potentially unchecked program_id',    remediation: 'Validate program_id against allowlist before invoking' },
  { id: 'RS-004', category: 'PDA Bump Not Verified',   severity: 'MEDIUM',   pattern: /find_program_address/,                                             message: 'PDA derived — verify canonical bump is stored', remediation: 'Store bump and use create_program_address with stored value' },
];

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS }); }

  const { code, language, filename } = body;
  if (!code || !language) return NextResponse.json({ error: 'code and language are required' }, { status: 400, headers: CORS });
  if (code.length > 50_000) return NextResponse.json({ error: 'Code exceeds 50KB limit' }, { status: 413, headers: CORS });

  const patterns = language === 'rust' ? RS_PATTERNS : TS_PATTERNS;
  const lines    = code.split('\n');
  const findings: any[] = [];

  for (const pat of patterns) {
    const re = typeof pat.pattern === 'string' ? new RegExp(pat.pattern, 'i') : pat.pattern;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const snippet = lines.slice(Math.max(0, i - 1), i + 3).join('\n');
        findings.push({ id: pat.id, severity: pat.severity, category: pat.category, line: i + 1, message: pat.message, remediation: pat.remediation, snippet, file: filename || 'submitted_code' });
        break; // one finding per pattern
      }
    }
  }

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {} as Record<string, number>);
  const overall = counts.CRITICAL ? 'CRITICAL' : counts.HIGH ? 'HIGH' : counts.MEDIUM ? 'MEDIUM' : counts.LOW ? 'LOW' : 'CLEAN';

  return NextResponse.json({ overall_risk: overall, counts, findings, loc: lines.length, generated_at: new Date().toISOString() }, { headers: CORS });
}

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }
