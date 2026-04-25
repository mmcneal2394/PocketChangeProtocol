export function normalizeVelocityMintData(mint: string, data: any): any {
  const isSynthetic = Boolean(data?.isSynthetic);
  const refinementOnly =
    data?.refinementOnly === true ||
    (data?.refinementOnly == null && isSynthetic);

  return {
    mint,
    ...(data || {}),
    isSynthetic,
    refinementOnly,
    syntheticSource: data?.syntheticSource || null,
  };
}

export function normalizeVelocitySnapshot(snapshot: any): any | null {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.mints || typeof snapshot.mints !== 'object') {
    return null;
  }

  const mints = Object.fromEntries(
    Object.entries(snapshot.mints).map(([mint, data]) => [mint, normalizeVelocityMintData(mint, data)]),
  );

  return {
    ...snapshot,
    mints,
  };
}

module.exports = {
  normalizeVelocityMintData,
  normalizeVelocitySnapshot,
};
