import fs from 'fs';
import path from 'path';

const { shouldPersistTradeRecord } = require('./trade_journal_logic.ts');
const { deriveKellyRewardAsymmetryFactor, summarizeProfitSeekingScores } = require('./profit_seeking_logic.ts');

const IS_PAPER = process.env.PAPER_MODE === 'true';
const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const JOURNAL_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl');
const OUTPUT_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'realized_profit_paper.json' : 'realized_profit.json');
const POLL_MS = Math.max(15_000, Number(process.env.PROFIT_ACCUMULATOR_POLL_MS || 60_000));
const REINVESTMENT_RATIO = Math.max(0, Math.min(1, Number(process.env.ARB_PROFIT_REINVESTMENT_RATIO || 0.8)));
const RUN_ONCE = process.argv.includes('--once');

type JournalTradeRecord = {
  action?: string;
  sig?: string;
  pnlSol?: number | string;
  ts?: number | string;
  tradeId?: string;
  parentBuyId?: string;
  partialExit?: boolean;
  reason?: string;
  symbol?: string;
  mint?: string;
};

type RealizedProfitSummary = {
  generatedAt: string;
  journalFile: string;
  isPaper: boolean;
  reinvestmentRatio: number;
  closedSellCount: number;
  wins: number;
  losses: number;
  positivePnlSol: number;
  negativePnlSol: number;
  totalRealizedPnlSol: number;
  eligibleProfitSol: number;
  realizedProfitSol: number;
  positiveProfitSeekingScore: number;
  negativeProfitSeekingScoreAbs: number;
  totalProfitSeekingScore: number;
  profitSeekingRatio: number;
  rewardAsymmetryFactor: number;
  lastSellTs: number | null;
};

function roundSol(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

function readJsonl(filePath: string): JournalTradeRecord[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function summarizeRealizedProfit(records: JournalTradeRecord[], reinvestmentRatio = REINVESTMENT_RATIO): RealizedProfitSummary {
  const normalizedRatio = Math.max(0, Math.min(1, Number.isFinite(Number(reinvestmentRatio)) ? Number(reinvestmentRatio) : REINVESTMENT_RATIO));
  const closed = (Array.isArray(records) ? records : [])
    .filter((record) => String(record?.action || '').toUpperCase() === 'SELL')
    .filter((record) => shouldPersistTradeRecord(record, IS_PAPER))
    .filter((record) => Number.isFinite(Number(record?.pnlSol)));

  const positivePnlSol = closed.reduce((sum, record) => sum + Math.max(0, Number(record?.pnlSol || 0)), 0);
  const negativePnlSol = closed.reduce((sum, record) => sum + Math.min(0, Number(record?.pnlSol || 0)), 0);
  const totalRealizedPnlSol = positivePnlSol + negativePnlSol;
  const profitSeeking = summarizeProfitSeekingScores(closed.map((record) => Number(record?.pnlSol || 0)));
  const wins = closed.filter((record) => Number(record?.pnlSol || 0) >= 0).length;
  const losses = closed.filter((record) => Number(record?.pnlSol || 0) < 0).length;
  const lastSellTs = closed.reduce((latest, record) => Math.max(latest, Number(record?.ts || 0) || 0), 0) || null;

  return {
    generatedAt: new Date().toISOString(),
    journalFile: JOURNAL_FILE,
    isPaper: IS_PAPER,
    reinvestmentRatio: normalizedRatio,
    closedSellCount: closed.length,
    wins,
    losses,
    positivePnlSol: roundSol(positivePnlSol),
    negativePnlSol: roundSol(negativePnlSol),
    totalRealizedPnlSol: roundSol(totalRealizedPnlSol),
    eligibleProfitSol: roundSol(Math.max(0, totalRealizedPnlSol) * normalizedRatio),
    realizedProfitSol: roundSol(Math.max(0, totalRealizedPnlSol)),
    positiveProfitSeekingScore: roundSol(profitSeeking.positiveScore),
    negativeProfitSeekingScoreAbs: roundSol(profitSeeking.negativeScoreAbs),
    totalProfitSeekingScore: roundSol(profitSeeking.totalScore),
    profitSeekingRatio: roundSol(profitSeeking.profitSeekingRatio),
    rewardAsymmetryFactor: roundSol(deriveKellyRewardAsymmetryFactor({
      profitSeekingRatio: profitSeeking.profitSeekingRatio,
      totalProfitSeekingScore: profitSeeking.totalScore,
      tradeCount: closed.length,
    })),
    lastSellTs,
  };
}

function ensureSignalsDir() {
  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
}

function writeSummary(summary: RealizedProfitSummary) {
  ensureSignalsDir();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(summary, null, 2), 'utf8');
}

async function runCycle() {
  const summary = summarizeRealizedProfit(readJsonl(JOURNAL_FILE), REINVESTMENT_RATIO);
  writeSummary(summary);
  console.log(
    `[PROFIT] sells=${summary.closedSellCount} pnl=${summary.totalRealizedPnlSol >= 0 ? '+' : ''}${summary.totalRealizedPnlSol.toFixed(6)} SOL ` +
    `eligible=${summary.eligibleProfitSol.toFixed(6)} SOL score=${summary.totalProfitSeekingScore.toFixed(6)} psr=${summary.profitSeekingRatio.toFixed(3)}`,
  );
}

async function main() {
  await runCycle();
  if (RUN_ONCE) return;
  setInterval(() => {
    runCycle().catch((error: any) => {
      console.error(`[PROFIT] Cycle failed: ${error?.message || error}`);
    });
  }, POLL_MS);
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(`[PROFIT] Fatal: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  summarizeRealizedProfit,
};
