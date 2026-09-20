import { describe, expect, it } from 'vitest';

import { CATALOG, matchesIdPattern, validateCheck } from '../../src/checks/catalog/index.js';
import { resolveChecks } from '../../src/checks/resolve.js';
import type { Check } from '../../src/checks/types.js';
import { DEFAULT_SETTINGS, parseSettingsLayer } from '../../src/config/schema.js';
import { AnswerShapeError, normalizeAnswer, positiveProbability } from '../../src/jev/answers.js';
import { applicableChecks, buildState, planRequests, questionKeyFor } from '../../src/jev/request.js';
import type { Chunk } from '../../src/scan/chunk.js';

const check = (over: Partial<Check> = {}): Check => ({
  id: 'test-check',
  title: 'Test',
  controls: ['A.8.28'],
  severity: 'high',
  scope: 'chunk',
  type: 'choice',
  instructions: 'Decide something.',
  criteria: { violation: 'bad', compliant: 'good', not_applicable: 'n/a' },
  kb: { requirement: 'r', why: 'w', impact: 'i', remediation: 'fix it', references: [] },
  version: 1,
  ...over,
});

const chunk = (over: Partial<Chunk> = {}): Chunk => ({
  id: 'src/a.php:1-10',
  language: 'php',
  files: [{ path: 'src/a.php', startLine: 1, endLine: 10, content: '<?php echo 1;' }],
  tokens: 20,
  packed: false,
  ...over,
});

describe('the shipped catalog', () => {
  it('is well formed', () => {
    expect(CATALOG.length).toBeGreaterThan(0);
    for (const entry of CATALOG) expect(validateCheck(entry)).toEqual([]);
  });

  it('gives every check knowledge-base prose', () => {
    for (const entry of CATALOG) {
      expect(entry.kb.requirement.length).toBeGreaterThan(40);
      expect(entry.kb.remediation.length).toBeGreaterThan(40);
      expect(entry.kb.references.length).toBeGreaterThan(0);
    }
  });

  it('offers a no-match label on every choice question', () => {
    for (const entry of CATALOG.filter((c) => c.type === 'choice')) {
      expect(Object.keys(entry.criteria ?? {})).toContain('not_applicable');
    }
  });

  it('catches a malformed check', () => {
    expect(validateCheck(check({ positiveLabels: ['nope'] })).join()).toContain('not one of its criteria');
    expect(validateCheck(check({ controls: ['8.28'] })).join()).toContain('not an Annex A reference');
    expect(validateCheck(check({ criteria: { only: 'one' } })).join()).toContain('at least two criteria');
  });
});

describe('check selection', () => {
  it('matches id globs', () => {
    expect(matchesIdPattern('a8-28-sql-injection', ['a8-*'])).toBe(true);
    expect(matchesIdPattern('a8-28-sql-injection', ['a5-*'])).toBe(false);
    expect(matchesIdPattern('anything', ['*'])).toBe(true);
  });

  it('applies include, exclude and severity overrides', () => {
    const { settings } = parseSettingsLayer(
      {
        checks: { include: ['a8-*'], exclude: ['a8-24-*'] },
        severityOverrides: { 'a8-28-sql-injection': 'low' },
        thresholds: { perCheck: { 'a8-28-sql-injection': 0.9 } },
      },
      'test',
    );
    const { checks, errors } = resolveChecks(settings);
    expect(errors).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(['a8-28-sql-injection']);
    expect(checks[0]?.severity).toBe('low');
    expect(checks[0]?.threshold).toBe(0.9);
  });

  it('reports an override that names a check which does not exist', () => {
    const { settings } = parseSettingsLayer({ severityOverrides: { 'no-such-check': 'low' } }, 'test');
    expect(resolveChecks(settings).errors.join()).toContain('unknown check "no-such-check"');
  });

  it('keeps overrides valid for a check the current run filtered out', () => {
    // Narrowing a run must not turn the project's settings into configuration errors.
    const { settings } = parseSettingsLayer(
      {
        checks: { include: ['a5-17-*'] },
        severityOverrides: { 'a8-28-sql-injection': 'low' },
        thresholds: { perCheck: { 'a8-24-weak-password-hash': 0.9 } },
        prompts: { append: { 'a8-28-sql-injection': 'note' } },
      },
      'test',
    );
    const resolved = resolveChecks(settings);
    expect(resolved.errors).toEqual([]);
    expect(resolved.checks.map((c) => c.id)).toEqual(['a5-17-hardcoded-credentials']);
  });

  it('accepts an extra check from settings and refuses a duplicate id', () => {
    const extra = {
      id: 'org-1-custom',
      title: 'Custom',
      controls: ['A.8.11'],
      instructions: 'Decide.',
      criteria: { violation: 'bad', compliant: 'good' },
      remediation: 'Do the thing.',
    };
    const ok = parseSettingsLayer({ extraChecks: [extra] }, 'test');
    const resolved = resolveChecks(ok.settings);
    expect(resolved.errors).toEqual([]);
    expect(resolved.checks.find((c) => c.id === 'org-1-custom')?.source).toBe('config');

    const clash = parseSettingsLayer({ extraChecks: [{ ...extra, id: 'a8-28-sql-injection' }] }, 'test');
    expect(resolveChecks(clash.settings).errors.join()).toContain('already used by a shipped check');
  });
});

describe('request building', () => {
  it('mangles ids into stable question keys', () => {
    expect(questionKeyFor('a8-24-weak-password-hash')).toBe('q_a8_24_weak_password_hash');
  });

  it('filters checks by language and path', () => {
    const phpOnly = check({ id: 'php-only', languages: ['php'] });
    const yamlOnly = check({ id: 'yaml-only', languages: ['yaml'] });
    const pathScoped = check({ id: 'path-scoped', appliesTo: ['**/migrations/**'] });
    const repoScoped = check({ id: 'repo-scoped', scope: 'repo' });

    const ids = applicableChecks(chunk(), [phpOnly, yamlOnly, pathScoped, repoScoped]).map((c) => c.id);
    expect(ids).toEqual(['php-only']);
  });

  it('puts every applicable question in one request when they fit', () => {
    const plans = planRequests(chunk(), [check({ id: 'a' }), check({ id: 'b' }), check({ id: 'c' })], DEFAULT_SETTINGS, 32_000);
    expect(plans).toHaveLength(1);
    expect(Object.keys(plans[0]!.questions)).toEqual(['q_a', 'q_b', 'q_c']);
    expect(plans[0]!.bindings.map((b) => b.check.id)).toEqual(['a', 'b', 'c']);
  });

  it('splits into the fewest requests when the context is too small', () => {
    const checks = Array.from({ length: 6 }, (_, i) => check({ id: `c${i}` }));
    const roomy = planRequests(chunk(), checks, DEFAULT_SETTINGS, 32_000)[0]!;
    const perQuestion = roomy.questionTokens / 6;

    // Size the context so about two questions fit beside the state.
    const context = Math.ceil((roomy.stateTokens + perQuestion * 2.5) / 0.9);
    const plans = planRequests(chunk(), checks, DEFAULT_SETTINGS, context);

    expect(plans.length).toBeGreaterThan(1);
    expect(plans.length).toBeLessThanOrEqual(3);
    const asked = plans.flatMap((p) => p.bindings.map((b) => b.check.id));
    expect(new Set(asked).size).toBe(6);
    expect(plans.every((p) => p.stateTokens === roomy.stateTokens)).toBe(true);
  });

  it('asks once, not once per question, when the state cannot fit the context', () => {
    // Splitting questions cannot rescue an oversized state: every request would carry the same one.
    const checks = Array.from({ length: 5 }, (_, i) => check({ id: `c${i}` }));
    const plans = planRequests(chunk(), checks, DEFAULT_SETTINGS, 40);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.oversized).toBe(true);
    expect(plans[0]?.bindings).toHaveLength(5);
  });

  it('includes project context and per-check notes', () => {
    const { settings } = parseSettingsLayer(
      { prompts: { projectContext: 'Payments service.', append: { a: 'QueryBuilder is safe.' } } },
      'test',
    );
    const state = buildState(chunk(), settings);
    expect(state.project_context).toBe('Payments service.');
    expect(state.files).toEqual([{ path: 'src/a.php', start_line: 1, content: '<?php echo 1;' }]);

    const plan = planRequests(chunk(), [check({ id: 'a' })], settings, 32_000)[0]!;
    expect(JSON.stringify(plan.questions.q_a?.instructions)).toContain('QueryBuilder is safe.');
  });
});

describe('answer normalisation', () => {
  it('reads a choice answer', () => {
    const answer = normalizeAnswer(
      { type: 'choice', choice: 'violation', confidence: 0.42, probabilities: { violation: 0.61, compliant: 0.35, not_applicable: 0.04 } },
      check(),
    );
    expect(answer).toMatchObject({ kind: 'choice', choice: 'violation', confidence: 0.42 });
    expect(positiveProbability(answer, check())).toBeCloseTo(0.61);
  });

  it('gates on probability mass, not on confidence', () => {
    // Confidence describes how concentrated the distribution is, so a confident "compliant" must not
    // read as a strong violation signal.
    const confidentlyCompliant = normalizeAnswer(
      { type: 'choice', choice: 'compliant', confidence: 0.99, probabilities: { violation: 0.01, compliant: 0.99 } },
      check(),
    );
    expect(positiveProbability(confidentlyCompliant, check())).toBeCloseTo(0.01);
  });

  it('sums probability across several positive labels', () => {
    const multi = check({
      criteria: { violation: 'a', likely_violation: 'b', compliant: 'c' },
      positiveLabels: ['violation', 'likely_violation'],
    });
    const answer = normalizeAnswer(
      { type: 'choice', choice: 'compliant', probabilities: { violation: 0.3, likely_violation: 0.3, compliant: 0.4 } },
      multi,
    );
    expect(positiveProbability(answer, multi)).toBeCloseTo(0.6);
  });

  it('reads a noul answer that carries no type field', () => {
    const noul = check({ type: 'noul', criteria: undefined });
    const answer = normalizeAnswer({ noul: 0.82 }, noul);
    expect(answer.kind).toBe('noul');
    expect(positiveProbability(answer, noul)).toBeCloseTo(0.82);
  });

  it('falls back to confidence when no distribution arrives', () => {
    const answer = normalizeAnswer({ type: 'choice', choice: 'violation', confidence: 0.7 }, check());
    expect(positiveProbability(answer, check())).toBeCloseTo(0.7);
  });

  it('rejects shapes it does not recognise', () => {
    expect(() => normalizeAnswer({ verdict: 'bad' }, check())).toThrow(AnswerShapeError);
    expect(() => normalizeAnswer(null, check())).toThrow(AnswerShapeError);
    expect(() => normalizeAnswer({ type: 'choice', choice: 'invented' }, check())).toThrow(/not one of its criteria/);
  });
});
