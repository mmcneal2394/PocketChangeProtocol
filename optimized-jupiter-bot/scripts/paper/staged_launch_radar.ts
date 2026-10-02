import fs from 'fs';
import path from 'path';

export type LaunchSource = 'gmgn' | 'helius' | 'bags' | 'market';
export type RadarDecision = 'reject' | 'watch_only' | 'provisional_candidate' | 'paper_entry_candidate';

export interface GmgnLaunchCandidate {
  mint: string;
  detectedAt: number;
  poolId?: string;
  name?: string;
  symbol?: string;
  imageUrl?: string;
  deployer?: string;
  liquidityUsd?: number;
  holderCount?: number;
  volume60sUsd?: number;
}

export interface HeliusEvidence {
  confirmed?: boolean;
  mintSafe?: boolean;
  poolId?: string;
  deployer?: string;
  commonControlSuspected?: boolean;
  observedAt?: number;
}

export interface BagsEvidence {
  launchKnown?: boolean;
  poolId?: string;
  creator?: string;
  observedAt?: number;
}

export interface MarketEvidence {
  poolId?: string;
  priceUsd?: number;
  priceSol?: number;
  liquidityUsd?: number;
  fresh?: boolean;
  observedAt?: number;
}

export interface StagedLaunchRadarInput {
  schemaVersion: 'staged-launch-radar-input/v1';
  generatedAt: number;
  gmgnCandidates: GmgnLaunchCandidate[];
  heliusByMint?: Record<string, HeliusEvidence>;
  bagsByMint?: Record<string, BagsEvidence>;
  marketByMint?: Record<string, MarketEvidence>;
}

export interface RadarCandidateResult {
  mint: string;
  symbol?: string;
  decision: RadarDecision;
  reasons: string[];
  sourceStatus: Record<LaunchSource, 'triggered' | 'confirmed' | 'missing' | 'stale' | 'conflict'>;
  provisional: {
    detectedAt: number;
    poolId?: string;
    minimumEvidenceSatisfied: boolean;
  };
  execution: {
    mode: 'paper_only';
    signing: 'disabled';
    broadcasting: 'disabled';
  };
}

export interface StagedLaunchRadarOutput {
  schemaVersion: 'staged-launch-radar-output/v1';
  generatedAt: number;
  execution: {
    mode: 'paper_only';
    networkIO: 'disabled';
    signing: 'disabled';
    broadcasting: 'disabled';
  };
  candidates: RadarCandidateResult[];
}

function validMint(mint: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

function finitePositive(value: number | undefined): boolean {
  return Number.isFinite(value) && Number(value) > 0;
}

function poolIdsConflict(ids: Array<string | undefined>): boolean {
  const distinct = new Set(ids.filter((id): id is string => Boolean(id)));
  return distinct.size > 1;
}

function evaluateCandidate(
  candidate: GmgnLaunchCandidate,
  input: StagedLaunchRadarInput,
): RadarCandidateResult {
  const helius = input.heliusByMint?.[candidate.mint];
  const bags = input.bagsByMint?.[candidate.mint];
  const market = input.marketByMint?.[candidate.mint];
  const reasons: string[] = [];
  const sourceStatus: RadarCandidateResult['sourceStatus'] = {
    gmgn: 'triggered',
    helius: helius?.confirmed ? 'confirmed' : 'missing',
    bags: bags?.launchKnown ? 'confirmed' : 'missing',
    market: market?.fresh ? 'confirmed' : market ? 'stale' : 'missing',
  };

  const poolConflict = poolIdsConflict([candidate.poolId, helius?.poolId, bags?.poolId, market?.poolId]);
  if (poolConflict) {
    reasons.push('cross_pool_conflict');
    for (const source of ['helius', 'bags', 'market'] as const) {
      if (sourceStatus[source] === 'confirmed') sourceStatus[source] = 'conflict';
    }
  }

  if (!validMint(candidate.mint)) reasons.push('invalid_mint');
  if (!candidate.poolId) reasons.push('missing_gmgn_pool_identity');
  if (helius?.mintSafe === false) reasons.push('unsafe_token_controls');
  if (helius?.commonControlSuspected) reasons.push('common_control_flow_suspected');

  const hardReject = reasons.some((reason) => [
    'invalid_mint',
    'cross_pool_conflict',
    'unsafe_token_controls',
    'common_control_flow_suspected',
  ].includes(reason));

  const minimumEvidenceSatisfied = Boolean(
    candidate.poolId &&
    helius?.confirmed &&
    helius.mintSafe === true &&
    market?.fresh &&
    (finitePositive(market.priceUsd) || finitePositive(market.priceSol)) &&
    finitePositive(market.liquidityUsd),
  );

  let decision: RadarDecision;
  if (hardReject) {
    decision = 'reject';
  } else if (minimumEvidenceSatisfied) {
    decision = 'paper_entry_candidate';
  } else if (candidate.poolId) {
    decision = 'provisional_candidate';
    if (!helius?.confirmed) reasons.push('awaiting_helius_confirmation');
    if (helius?.mintSafe !== true) reasons.push('awaiting_token_safety');
    if (!market?.fresh || (!finitePositive(market.priceUsd) && !finitePositive(market.priceSol)) || !finitePositive(market.liquidityUsd)) {
      reasons.push('awaiting_fresh_independent_market_mark');
    }
  } else {
    decision = 'watch_only';
  }

  return {
    mint: candidate.mint,
    symbol: candidate.symbol,
    decision,
    reasons,
    sourceStatus,
    provisional: {
      detectedAt: candidate.detectedAt,
      poolId: candidate.poolId,
      minimumEvidenceSatisfied,
    },
    execution: {
      mode: 'paper_only',
      signing: 'disabled',
      broadcasting: 'disabled',
    },
  };
}

export function buildStagedLaunchRadar(input: StagedLaunchRadarInput): StagedLaunchRadarOutput {
  if (input?.schemaVersion !== 'staged-launch-radar-input/v1') {
    throw new Error('schemaVersion must be staged-launch-radar-input/v1.');
  }
  if (!Array.isArray(input.gmgnCandidates)) throw new Error('gmgnCandidates must be an array.');

  const newestByMint = new Map<string, GmgnLaunchCandidate>();
  for (const candidate of input.gmgnCandidates) {
    const existing = newestByMint.get(candidate.mint);
    if (!existing || candidate.detectedAt > existing.detectedAt) newestByMint.set(candidate.mint, candidate);
  }

  return {
    schemaVersion: 'staged-launch-radar-output/v1',
    generatedAt: input.generatedAt,
    execution: {
      mode: 'paper_only',
      networkIO: 'disabled',
      signing: 'disabled',
      broadcasting: 'disabled',
    },
    candidates: [...newestByMint.values()]
      .sort((left, right) => right.detectedAt - left.detectedAt)
      .map((candidate) => evaluateCandidate(candidate, input)),
  };
}

function parseArgs(args: string[]) {
  const inputIndex = args.indexOf('--input');
  const outIndex = args.indexOf('--out');
  return {
    input: inputIndex >= 0 ? args[inputIndex + 1] : undefined,
    out: outIndex >= 0 ? args[outIndex + 1] : undefined,
  };
}

if (require.main === module) {
  const { input, out } = parseArgs(process.argv.slice(2));
  if (!input || !out) {
    console.error('Usage: ts-node scripts/paper/staged_launch_radar.ts --input <provider-snapshots.json> --out <paper-radar.json>');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(input, 'utf8')) as StagedLaunchRadarInput;
  const output = buildStagedLaunchRadar(payload);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote paper-only staged launch radar: ${out}`);
}
