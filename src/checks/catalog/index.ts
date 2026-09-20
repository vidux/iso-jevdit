import type { Check } from '../types.js';
import { a5Checks } from './a5-organizational.js';
import { a8CryptoChecks } from './a8-crypto.js';
import { a8SecureCodingChecks } from './a8-secure-coding.js';

/** The shipped catalog. Order here is only a tie-breaker; the report sorts by control. */
export const CATALOG: readonly Check[] = Object.freeze(
  [...a5Checks, ...a8CryptoChecks, ...a8SecureCodingChecks].map((c) => ({ ...c, source: 'catalog' as const })),
);

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_RE = /^A\.\d{1,2}\.\d{1,2}$/;

/** Criteria may be a string, a structured object/array, or null when the label name suffices. */
function isEmptyDefinition(value: unknown): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return true;
}

/** Returns human-readable problems; empty means the check is well formed. */
export function validateCheck(check: Check): string[] {
  const problems: string[] = [];
  const at = `check "${check.id}"`;

  if (!ID_RE.test(check.id)) problems.push(`${at}: id must be lower-case words separated by hyphens`);
  if (!check.title.trim()) problems.push(`${at}: title is empty`);
  if (check.controls.length === 0) problems.push(`${at}: needs at least one Annex A control reference`);
  for (const control of check.controls) {
    if (!CONTROL_RE.test(control)) problems.push(`${at}: "${control}" is not an Annex A reference like "A.8.24"`);
  }
  if (isEmptyDefinition(check.instructions)) problems.push(`${at}: instructions are empty`);

  if (check.type === 'choice') {
    const labels = Object.keys(check.criteria ?? {});
    if (labels.length < 2) problems.push(`${at}: a choice question needs at least two criteria labels`);
    if (labels.length > 255) problems.push(`${at}: a choice question takes at most 255 labels`);
    for (const [label, text] of Object.entries(check.criteria ?? {})) {
      if (isEmptyDefinition(text)) problems.push(`${at}: criteria label "${label}" has no definition`);
    }
    for (const label of check.positiveLabels ?? ['violation']) {
      if (!labels.includes(label)) {
        problems.push(`${at}: positiveLabels names "${label}", which is not one of its criteria`);
      }
    }
  } else if (check.type === 'noul' && check.criteria && Object.keys(check.criteria).length > 0) {
    problems.push(`${at}: a noul question takes instructions only, not criteria`);
  }

  if (check.threshold !== undefined && (check.threshold <= 0 || check.threshold > 1)) {
    problems.push(`${at}: threshold must be greater than 0 and at most 1`);
  }
  if (!check.kb || !check.kb.requirement?.trim() || !check.kb.remediation?.trim()) {
    problems.push(`${at}: knowledge-base entry is missing requirement or remediation text`);
  }
  return problems;
}

function assertCatalogIsWellFormed(checks: readonly Check[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.id)) problems.push(`duplicate check id "${check.id}"`);
    seen.add(check.id);
    problems.push(...validateCheck(check));
  }
  if (problems.length > 0) {
    throw new Error(`the shipped check catalog is malformed:\n  - ${problems.join('\n  - ')}`);
  }
}

// A malformed catalog is a bug in this package, so it fails at import rather than mid-audit.
assertCatalogIsWellFormed(CATALOG);

export function checkById(id: string): Check | undefined {
  return CATALOG.find((c) => c.id === id);
}

/** Matches an id against `a8-*` style patterns. */
export function matchesIdPattern(id: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`).test(id);
  });
}
