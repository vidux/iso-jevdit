/**
 * Every sink that can persist text - report, cache, logs, error messages - passes through here.
 */

const SECRET_PATTERNS: Array<{ re: RegExp; keep: number }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, keep: 0 },
  { re: /\bsk-(?:or-)?(?:v\d-)?[A-Za-z0-9_-]{20,}/g, keep: 4 },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, keep: 4 },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, keep: 4 },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, keep: 4 },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keep: 4 },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: 4 },
];

const ASSIGNMENT_RE =
  /((?:pass(?:word|wd)?|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)\s*(?:=>|[:=])\s*)(['"`])([^'"`\n]{4,})\2/gi;

function stars(n: number): string {
  return '*'.repeat(Math.max(4, Math.min(n, 32)));
}

/** First 8 and last 4 only - enough to recognise a key, never enough to use one. */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return stars(8);
  return `${key.slice(0, 8)}${stars(key.length - 12)}${key.slice(-4)}`;
}

/** Mask secret-shaped values inside arbitrary text (report snippets, log lines). */
export function maskSecretsInText(text: string): string {
  let out = text;
  for (const { re, keep } of SECRET_PATTERNS) {
    out = out.replace(re, (m) => (keep > 0 && m.length > keep + 4 ? `${m.slice(0, 4)}${stars(m.length - keep - 4)}${m.slice(-keep)}` : stars(12)));
  }
  out = out.replace(ASSIGNMENT_RE, (_m, lhs: string, quote: string, value: string) => `${lhs}${quote}${stars(value.length)}${quote}`);
  return out;
}

/**
 * Masks known literal secrets (the resolved API key) plus anything secret-shaped. Known values are
 * handled first so a key that no pattern recognises still never escapes.
 */
export function createRedactor(knownSecrets: Iterable<string>): (text: string) => string {
  const known = [...knownSecrets].filter((s) => s && s.length >= 8).sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const secret of known) out = out.split(secret).join(maskKey(secret));
    return maskSecretsInText(out);
  };
}
