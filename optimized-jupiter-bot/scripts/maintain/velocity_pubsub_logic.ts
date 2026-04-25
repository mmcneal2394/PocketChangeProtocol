export function classifyVelocityPubsubPayload(raw: any): {
  kind: 'delta' | 'snapshot' | 'invalid';
  spikeCount: number;
} {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'invalid', spikeCount: 0 };
  }

  if (Array.isArray(raw.mints)) {
    return { kind: 'delta', spikeCount: raw.mints.length };
  }

  if (raw.mints && typeof raw.mints === 'object') {
    return { kind: 'snapshot', spikeCount: Object.keys(raw.mints).length };
  }

  return { kind: 'invalid', spikeCount: 0 };
}

module.exports = {
  classifyVelocityPubsubPayload,
};
