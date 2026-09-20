import { describe, expect, it } from 'vitest';

import { runEngine } from '../../src/audit/engine.js';
import type { Check } from '../../src/checks/types.js';
import { DEFAULT_SETTINGS } from '../../src/config/schema.js';
import type { DecisionProvider } from '../../src/providers/types.js';
import { renderMarkdownReport } from '../../src/report/markdown.js';
import type { Chunk } from '../../src/scan/chunk.js';
import type { DiscoveryResult } from '../../src/scan/discover.js';

const checks: Check[] = [
  {
    id: 'test-unsafe',
    title: 'Unsafe test behavior',
    controls: ['A.8.28'],
    severity: 'high',
    scope: 'chunk',
    type: 'choice',
    instructions: 'Is this unsafe?',
    criteria: { violation: 'unsafe', compliant: 'safe', not_applicable: 'irrelevant' },
    kb: {
      requirement: 'Code must avoid the unsafe test behavior.',
      why: 'The behavior can expose protected information.',
      impact: 'An attacker may gain unauthorized access.',
      remediation: 'Replace the unsafe behavior with the approved implementation.',
      references: ['ISO/IEC 27001:2022 A.8.28'],
    },
    version: 1,
  },
];

const chunks: Chunk[] = [
  {
    id: 'src/bad.ts:1-1',
    language: 'typescript',
    files: [{ path: 'src/bad.ts', startLine: 1, endLine: 1, content: 'const bad = true;' }],
    tokens: 10,
    packed: false,
  },
  {
    id: 'src/good.ts:1-1',
    language: 'typescript',
    files: [{ path: 'src/good.ts', startLine: 1, endLine: 1, content: 'const good = true;' }],
    tokens: 10,
    packed: false,
  },
];

function provider(): DecisionProvider {
  return {
    name: 'test',
    model: 'test-model',
    contextTokens: 32_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 0 },
    async verifyKey() {
      return { ok: true, detail: 'test' };
    },
    async decide(request) {
      const unsafe = JSON.stringify(request.state).includes('bad.ts');
      return {
        answers: {
          q_test_unsafe: unsafe
            ? { type: 'choice', choice: 'violation', confidence: 0.9, probabilities: { violation: 0.9, compliant: 0.1 } }
            : { type: 'choice', choice: 'compliant', confidence: 0.9, probabilities: { violation: 0.1, compliant: 0.9 } },
        },
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

describe('audit engine and report', () => {
  it('tracks processed, clean, and affected files', async () => {
    const result = await runEngine({
      chunks,
      files: ['src/bad.ts', 'src/good.ts'],
      checks,
      settings: { ...DEFAULT_SETTINGS, concurrency: 2 },
      provider: provider(),
    });

    expect(result.stats).toMatchObject({
      totalFiles: 2,
      processedFiles: 2,
      filesOk: 1,
      filesWithIssues: 1,
      totalRequests: 2,
      completedRequests: 2,
      findings: 1,
      inputTokens: 200,
      outputTokens: 20,
    });
    expect(result.findings[0]?.id).toMatch(/^test-unsafe@src\/bad\.ts#/);
  });

  it('renders a useful final Markdown report', async () => {
    const result = await runEngine({
      chunks,
      files: ['src/bad.ts', 'src/good.ts'],
      checks,
      settings: DEFAULT_SETTINGS,
      provider: provider(),
    });
    const discovery: DiscoveryResult = {
      root: '/repo',
      files: [],
      skips: [],
      counts: { eligible: 2, ignoredDirs: 0, ignoredFiles: 0, tooLarge: 0, notEligible: 0, skipRecordsOmitted: 0 },
      explicitFile: false,
    };
    const report = renderMarkdownReport({
      result,
      settings: { ...DEFAULT_SETTINGS, report: { ...DEFAULT_SETTINGS.report, timestamp: false } },
      checks,
      provider: {
        name: 'test',
        model: 'test-model',
        baseUrl: 'https://example.test',
        timeoutMs: 1000,
        maxRetries: 0,
        headers: {},
        apiKeyEnv: 'TEST_KEY',
        defaults: {
          baseUrl: 'https://example.test',
          model: 'test-model',
          transport: 'decisions',
          contextTokens: 32_000,
          pricing: { inputPerMTok: 1, outputPerMTok: 0 },
          apiKeyEnv: 'TEST_KEY',
          decisionsPath: '/decisions',
          keyCheckPath: '/key',
          keyHint: 'https://example.test/key',
          timeoutMs: 1000,
          maxRetries: 0,
        },
      },
      root: '/repo',
      targetPath: '/repo',
      discovery,
      readSkips: [],
      git: null,
      version: '0.1.0',
    });

    expect(report).toContain('## Executive summary');
    expect(report).toContain('**1** file(s) with findings; **1** file(s) had no finding');
    expect(report).toContain('## Findings');
    expect(report).toContain('src/bad.ts:1-1');
    expect(report).toContain('## Appendix C — Methodology and limitations');
  });
});