import type { ExtraCheckSettings, Settings } from '../config/schema.js';
import { CATALOG, matchesIdPattern, validateCheck } from './catalog/index.js';
import type { Check } from './types.js';

function toCheck(extra: ExtraCheckSettings): Check {
  return {
    id: extra.id,
    title: extra.title,
    controls: extra.controls,
    severity: extra.severity,
    scope: extra.scope,
    ...(extra.appliesTo ? { appliesTo: extra.appliesTo } : {}),
    ...(extra.languages ? { languages: extra.languages } : {}),
    type: extra.type,
    instructions: extra.instructions,
    ...(extra.criteria ? { criteria: extra.criteria } : {}),
    ...(extra.positiveLabels ? { positiveLabels: extra.positiveLabels } : {}),
    ...(extra.threshold !== undefined ? { threshold: extra.threshold } : {}),
    kb: {
      requirement: extra.requirement?.trim() || extra.title,
      why: extra.why ?? '',
      impact: extra.impact ?? '',
      remediation: extra.remediation,
      references:
        extra.references.length > 0
          ? extra.references
          : extra.controls.map((control) => `ISO/IEC 27001:2022 Annex A ${control.replace(/^A\./, '')}`),
    },
    version: 1,
    source: 'config',
  };
}

export interface ResolvedChecks {
  checks: Check[];
  errors: string[];
}

/**
 * Shipped catalog filtered by `checks.include`/`exclude`, plus the project's own `extraChecks`, with
 * per-check severity and threshold overrides applied.
 */
export function resolveChecks(settings: Settings): ResolvedChecks {
  const errors: string[] = [];
  const selected: Check[] = [];
  const seen = new Set<string>();

  for (const check of CATALOG) {
    if (!matchesIdPattern(check.id, settings.checks.include)) continue;
    if (settings.checks.exclude.length > 0 && matchesIdPattern(check.id, settings.checks.exclude)) continue;
    selected.push(check);
    seen.add(check.id);
  }

  for (const extra of settings.extraChecks) {
    const check = toCheck(extra);
    const problems = validateCheck(check);
    if (problems.length > 0) {
      errors.push(...problems.map((p) => `extraChecks: ${p}`));
      continue;
    }
    if (seen.has(check.id)) {
      errors.push(`extraChecks: id "${check.id}" is already used by a shipped check - choose another id`);
      continue;
    }
    if (!matchesIdPattern(check.id, settings.checks.include)) continue;
    if (settings.checks.exclude.length > 0 && matchesIdPattern(check.id, settings.checks.exclude)) continue;
    selected.push(check);
    seen.add(check.id);
  }

  const checks = selected.map((check) => {
    const severity = settings.severityOverrides[check.id] ?? check.severity;
    const threshold = settings.thresholds.perCheck[check.id] ?? check.threshold;
    return { ...check, severity, ...(threshold !== undefined ? { threshold } : {}) };
  });

  // Validated against every check that exists, not just the selected ones: narrowing a run with
  // --checks must not turn the project's own overrides into configuration errors.
  const known = new Set<string>([...CATALOG.map((c) => c.id), ...settings.extraChecks.map((c) => c.id)]);
  for (const [label, ids] of [
    ['thresholds.perCheck', Object.keys(settings.thresholds.perCheck)],
    ['severityOverrides', Object.keys(settings.severityOverrides)],
    ['prompts.append', Object.keys(settings.prompts.append)],
  ] as const) {
    for (const id of ids) {
      if (!known.has(id)) errors.push(`${label} names unknown check "${id}"`);
    }
  }

  checks.sort((a, b) => (a.controls[0] ?? '').localeCompare(b.controls[0] ?? '') || a.id.localeCompare(b.id));
  return { checks, errors };
}

export function effectiveThreshold(check: Check, settings: Settings): number {
  return check.threshold ?? settings.thresholds.report;
}
