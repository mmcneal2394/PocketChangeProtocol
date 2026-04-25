function normalizeLogLine(value: unknown): string {
  return String(value || '').trim();
}

export function hasVelocitySwapSignal(logs: unknown): boolean {
  if (!Array.isArray(logs) || logs.length === 0) return false;
  const lines = logs.map(normalizeLogLine).filter(Boolean);
  if (lines.length === 0) return false;

  return lines.some((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes('instruction: buy') ||
      lower.includes('instruction: sell') ||
      lower.includes('instruction: swap') ||
      lower.includes('program log: swap') ||
      lower.includes(' swap ')
    );
  });
}

module.exports = {
  hasVelocitySwapSignal,
};
