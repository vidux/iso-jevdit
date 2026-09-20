export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Most severe first - the order the report uses. */
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function severityAtLeast(s: Severity, min: Severity): boolean {
  return severityRank(s) <= severityRank(min);
}

/** One step less severe, for findings that clear the report threshold but not the high one. */
export function demoteSeverity(s: Severity): Severity {
  return SEVERITIES[Math.min(severityRank(s) + 1, SEVERITIES.length - 1)] ?? s;
}

export type CheckScope = 'chunk' | 'repo';
export type QuestionKind = 'choice' | 'noul' | 'score';

/**
 * A criteria entry is a string, or a structured object whose field names the model also sees
 * (`what` / `not_for` / `examples` is the shape that separates look-alike labels), or null when the
 * label name speaks for itself. Transports that accept strings only encode these; see
 * providers/openrouter.ts.
 */
export type CriteriaValue = string | null | Record<string, unknown> | readonly unknown[];
export type InstructionsValue = string | Record<string, unknown>;

export interface QuestionSpec {
  type: QuestionKind;
  instructions: InstructionsValue;
  criteria?: Record<string, CriteriaValue>;
}

export interface KbEntry {
  /** What the control requires, in the auditor's terms. */
  requirement: string;
  why: string;
  impact: string;
  remediation: string;
  references: string[];
}

export interface Check {
  id: string;
  title: string;
  /** Annex A 2022 control references, e.g. ['A.8.24']. */
  controls: string[];
  severity: Severity;
  scope: CheckScope;
  /** Gitignore-style path globs; omitted means every eligible file. */
  appliesTo?: string[];
  /** Language ids from scan/extensions; omitted means every language. */
  languages?: string[];
  type: QuestionKind;
  instructions: InstructionsValue;
  criteria?: Record<string, CriteriaValue>;
  /** Labels that mean "violation found" (default ['violation']). */
  positiveLabels?: string[];
  threshold?: number;
  kb: KbEntry;
  /** Bump when instructions/criteria change: it invalidates this check's cache entries. */
  version: number;
  /** Set for checks that came from settings.json rather than the shipped catalog. */
  source?: 'catalog' | 'config';
}

export function positiveLabelsOf(check: Check): string[] {
  return check.positiveLabels ?? ['violation'];
}
