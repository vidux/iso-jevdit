/**
 * Jev's tokenizer is not published, so every estimate here is an approximation with a documented
 * band. Runs reconcile against the `usage` each response reports.
 */
export const CHARS_PER_TOKEN = 3.8;
export const ESTIMATE_BAND = 0.25;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? '');
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
