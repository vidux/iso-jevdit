import type { Check } from '../checks/types.js';
import type { Settings } from '../config/schema.js';
import { planRequests } from '../jev/request.js';
import type { Chunk } from '../scan/chunk.js';
import type { Pricing } from '../providers/types.js';
import { ESTIMATE_BAND } from '../util/tokens.js';

export interface LanguageBreakdown {
  language: string;
  /** Distinct files, so a file split across chunks is still counted once. */
  files: number;
  chunks: number;
  requests: number;
}

export interface Estimate {
  chunks: number;
  packedChunks: number;
  requests: number;
  /** Chunks whose state alone exceeds the usable context - these requests will be rejected. */
  oversizedChunks: number;
  /** Chunks with no applicable check - they cost nothing and are reported as unasked. */
  skippedChunks: number;
  stateTokens: number;
  questionTokens: number;
  inputTokens: number;
  costUsd: number;
  lowUsd: number;
  highUsd: number;
  minChecksPerChunk: number;
  maxChecksPerChunk: number;
  byLanguage: LanguageBreakdown[];
}

export interface EstimateInput {
  chunks: readonly Chunk[];
  checks: readonly Check[];
  settings: Settings;
  contextTokens: number;
  pricing: Pricing;
}

export function buildEstimate(input: EstimateInput): Estimate {
  const byLanguage = new Map<string, LanguageBreakdown>();
  let stateTokens = 0;
  let questionTokens = 0;
  let requests = 0;
  let packedChunks = 0;
  let skippedChunks = 0;
  let oversizedChunks = 0;
  const filesByLanguage = new Map<string, Set<string>>();
  let minChecks = Number.POSITIVE_INFINITY;
  let maxChecks = 0;

  for (const chunk of input.chunks) {
    const plans = planRequests(chunk, input.checks, input.settings, input.contextTokens);
    const entry = byLanguage.get(chunk.language) ?? { language: chunk.language, files: 0, chunks: 0, requests: 0 };
    entry.chunks += 1;
    entry.requests += plans.length;
    byLanguage.set(chunk.language, entry);

    const seenPaths = filesByLanguage.get(chunk.language) ?? new Set<string>();
    for (const file of chunk.files) seenPaths.add(file.path);
    filesByLanguage.set(chunk.language, seenPaths);

    if (chunk.packed) packedChunks += 1;
    if (plans.length === 0) {
      skippedChunks += 1;
      continue;
    }

    if (plans.some((plan) => plan.oversized)) oversizedChunks += 1;
    const checksHere = plans.reduce((sum, plan) => sum + plan.bindings.length, 0);
    minChecks = Math.min(minChecks, checksHere);
    maxChecks = Math.max(maxChecks, checksHere);
    requests += plans.length;
    for (const plan of plans) {
      stateTokens += plan.stateTokens;
      questionTokens += plan.questionTokens;
    }
  }

  const inputTokens = stateTokens + questionTokens;
  // Output is free on Jev, so input tokens are the whole bill.
  const costUsd = (inputTokens / 1e6) * input.pricing.inputPerMTok;

  for (const entry of byLanguage.values()) {
    entry.files = filesByLanguage.get(entry.language)?.size ?? 0;
  }

  return {
    chunks: input.chunks.length,
    packedChunks,
    requests,
    oversizedChunks,
    skippedChunks,
    stateTokens,
    questionTokens,
    inputTokens,
    costUsd,
    lowUsd: costUsd * (1 - ESTIMATE_BAND),
    highUsd: costUsd * (1 + ESTIMATE_BAND),
    minChecksPerChunk: Number.isFinite(minChecks) ? minChecks : 0,
    maxChecksPerChunk: maxChecks,
    byLanguage: [...byLanguage.values()].sort((a, b) => b.chunks - a.chunks || a.language.localeCompare(b.language)),
  };
}
