import fs from 'fs';
import path from 'path';
import {
  buildStagedLaunchRadar,
  MarketEvidence,
  StagedLaunchRadarInput,
} from './staged_launch_radar';
import {
  createLocalPaperTraderState,
  LocalPaperTraderInput,
  LocalPaperTraderState,
  RpcUsage,
  runLocalPaperTrader,
} from './local_paper_trader';

export interface LocalPaperCycleInput {
  schemaVersion: 'local-paper-cycle-input/v1';
  radarInput: StagedLaunchRadarInput;
  rpcUsage?: Record<string, RpcUsage>;
}

function finitePositive(value: unknown): boolean {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function pipelineState(input: StagedLaunchRadarInput) {
  const now = input.generatedAt;
  const marketRows = Object.values(input.marketByMint || {});
  const heliusRows = Object.values(input.heliusByMint || {});
  const bagsRows = Object.values(input.bagsByMint || {});
  return {
    gmgn: {
      status: input.gmgnCandidates.length ? 'fresh' as const : 'missing' as const,
      updatedAt: now,
      detail: `${input.gmgnCandidates.length} filtered candidate(s)`,
    },
    helius: {
      status: heliusRows.some((row) => row.confirmed) ? 'fresh' as const : 'missing' as const,
      updatedAt: now,
      detail: `${heliusRows.filter((row) => row.confirmed).length} confirmed mint(s)`,
    },
    bags: {
      status: bagsRows.some((row) => row.launchKnown) ? 'fresh' as const : 'missing' as const,
      updatedAt: now,
      detail: `${bagsRows.filter((row) => row.launchKnown).length} Bags launch record(s)`,
    },
    market: {
      status: marketRows.some((row) => row.fresh) ? 'fresh' as const : marketRows.length ? 'stale' as const : 'missing' as const,
      updatedAt: now,
      detail: `${marketRows.filter((row) => row.fresh).length} fresh independent mark(s)`,
    },
  };
}

export function buildLocalPaperTraderInput(cycle: LocalPaperCycleInput): LocalPaperTraderInput {
  if (cycle?.schemaVersion !== 'local-paper-cycle-input/v1') throw new Error('schemaVersion must be local-paper-cycle-input/v1.');
  const radar = buildStagedLaunchRadar(cycle.radarInput);
  const marketByMint = cycle.radarInput.marketByMint || {};
  const marksByMint = Object.fromEntries(Object.entries(marketByMint)
    .filter(([, evidence]) => finitePositive((evidence as MarketEvidence).priceSol))
    .map(([mint, evidence]) => [mint, {
      priceSol: Number((evidence as MarketEvidence).priceSol),
      updatedAt: Number((evidence as MarketEvidence).observedAt || cycle.radarInput.generatedAt),
      fresh: (evidence as MarketEvidence).fresh === true,
    }]));

  return {
    schemaVersion: 'local-paper-trader-input/v1',
    generatedAt: cycle.radarInput.generatedAt,
    candidates: radar.candidates.map((candidate) => ({
      mint: candidate.mint,
      symbol: candidate.symbol,
      decision: candidate.decision,
      entryPriceSol: marksByMint[candidate.mint]?.priceSol,
      reasons: candidate.reasons,
    })),
    marksByMint,
    rpcUsage: cycle.rpcUsage || {},
    pipeline: pipelineState(cycle.radarInput),
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function parseArgs(args: string[]) {
  const valueFor = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return { input: valueFor('--input'), state: valueFor('--state'), radarOut: valueFor('--radar-out') };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.state) {
    console.error('Usage: ts-node scripts/paper/local_paper_cycle.ts --input <cycle-input.json> --state <state.json> [--radar-out <radar-output.json>]');
    process.exit(1);
  }
  const cycle = readJson<LocalPaperCycleInput>(args.input);
  const traderInput = buildLocalPaperTraderInput(cycle);
  const state = fs.existsSync(args.state)
    ? readJson<LocalPaperTraderState>(args.state)
    : createLocalPaperTraderState();
  const next = runLocalPaperTrader(state, traderInput);
  fs.mkdirSync(path.dirname(args.state), { recursive: true });
  fs.writeFileSync(args.state, `${JSON.stringify(next, null, 2)}\n`);
  if (args.radarOut) {
    fs.mkdirSync(path.dirname(args.radarOut), { recursive: true });
    fs.writeFileSync(args.radarOut, `${JSON.stringify(buildStagedLaunchRadar(cycle.radarInput), null, 2)}\n`);
  }
  console.log(JSON.stringify({ execution: next.execution, openPositions: next.positions.filter((position) => position.closedAt === null).length }, null, 2));
}
