import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli.js';
import { buildEstimate } from '../../src/audit/estimate.js';
import { CATALOG } from '../../src/checks/catalog/index.js';
import { DEFAULT_SETTINGS } from '../../src/config/schema.js';
import type { Chunk } from '../../src/scan/chunk.js';

describe('flag parsing', () => {
  it('accepts --flag=value and --flag value', () => {
    expect(parseArgs(['--provider=openrouter']).values.get('provider')).toBe('openrouter');
    expect(parseArgs(['--provider', 'openrouter']).values.get('provider')).toBe('openrouter');
  });

  it('treats "-" as a value for --key rather than a flag', () => {
    const parsed = parseArgs(['--key', '-']);
    expect(parsed.values.get('key')).toBe('-');
    expect(parsed.positionals).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  it('makes --clear-key work with and without a provider', () => {
    expect(parseArgs(['--clear-key']).values.get('clear-key')).toBe(true);
    expect(parseArgs(['--clear-key', 'openrouter']).values.get('clear-key')).toBe('openrouter');
    // A following path must not be eaten as the optional value's neighbour.
    const withPath = parseArgs(['--clear-credentials', 'src']);
    expect(withPath.positionals).toEqual(['src']);
  });

  it('handles --no- forms for switches only', () => {
    expect(parseArgs(['--no-gitignore']).values.get('gitignore')).toBe(false);
    expect(parseArgs(['--no-verify']).values.get('verify')).toBe(false);
    expect(parseArgs(['--no-provider']).errors.join()).toContain('not a switch');
  });

  it('collects repeatable and comma-separated lists', () => {
    const parsed = parseArgs(['--ignore', 'a/**', '--ignore=b/**', '--checks', 'a8-24-*,a5-17-*']);
    expect(parsed.values.get('ignore')).toEqual(['a/**', 'b/**']);
    expect(parsed.values.get('checks')).toEqual(['a8-24-*', 'a5-17-*']);
  });

  it('parses negative and decimal numbers', () => {
    expect(parseArgs(['--threshold', '0.75']).values.get('threshold')).toBe(0.75);
    expect(parseArgs(['--max-spend=2.5']).values.get('max-spend')).toBe(2.5);
    expect(parseArgs(['--concurrency', 'eight']).errors.join()).toContain('needs a number');
  });

  it('does not let a number flag swallow the next option', () => {
    const parsed = parseArgs(['--concurrency', '--verbose']);
    expect(parsed.errors.join()).toContain('"--concurrency" needs a value');
    expect(parsed.values.get('verbose')).toBe(true);
  });

  it('still accepts a negative number as a value', () => {
    expect(parseArgs(['--threshold', '-1']).values.get('threshold')).toBe(-1);
  });

  it('rejects an unknown flag by name', () => {
    expect(parseArgs(['--wat']).errors.join()).toContain('unknown option "--wat"');
  });

  it('keeps one positional path and honours --', () => {
    expect(parseArgs(['src/auth.php']).positionals).toEqual(['src/auth.php']);
    expect(parseArgs(['--', '--weird-name.php']).positionals).toEqual(['--weird-name.php']);
  });

  it('maps short flags', () => {
    expect(parseArgs(['-v']).values.get('verbose')).toBe(true);
    expect(parseArgs(['-h']).values.get('help')).toBe(true);
  });
});

describe('cost forecast', () => {
  const chunk = (id: string, tokens: number): Chunk => ({
    id,
    language: 'php',
    files: [{ path: `${id}.php`, startLine: 1, endLine: 10, content: 'x'.repeat(tokens * 4) }],
    tokens,
    packed: false,
  });

  it('bills input only, and bands the estimate', () => {
    const estimate = buildEstimate({
      chunks: [chunk('a', 100), chunk('b', 100)],
      checks: CATALOG,
      settings: DEFAULT_SETTINGS,
      contextTokens: 32_000,
      pricing: { inputPerMTok: 0.042, outputPerMTok: 0 },
    });

    expect(estimate.requests).toBe(2);
    expect(estimate.inputTokens).toBe(estimate.stateTokens + estimate.questionTokens);
    expect(estimate.costUsd).toBeCloseTo((estimate.inputTokens / 1e6) * 0.042, 10);
    expect(estimate.lowUsd).toBeLessThan(estimate.costUsd);
    expect(estimate.highUsd).toBeGreaterThan(estimate.costUsd);
  });

  it('shows the question block dominating cost on small chunks', () => {
    const estimate = buildEstimate({
      chunks: [chunk('a', 50)],
      checks: CATALOG,
      settings: DEFAULT_SETTINGS,
      contextTokens: 32_000,
      pricing: { inputPerMTok: 0.042, outputPerMTok: 0 },
    });
    expect(estimate.questionTokens).toBeGreaterThan(estimate.stateTokens);
  });

  it('counts a chunk with no applicable check as unasked and free', () => {
    const estimate = buildEstimate({
      chunks: [{ ...chunk('a', 100), language: 'json' }],
      checks: CATALOG.filter((c) => c.languages !== undefined),
      settings: DEFAULT_SETTINGS,
      contextTokens: 32_000,
      pricing: { inputPerMTok: 0.042, outputPerMTok: 0 },
    });
    expect(estimate.skippedChunks).toBe(1);
    expect(estimate.requests).toBe(0);
    expect(estimate.costUsd).toBe(0);
  });
});
