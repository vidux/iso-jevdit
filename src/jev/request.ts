import ignoreFactory from 'ignore';

import type { Check, InstructionsValue, QuestionSpec } from '../checks/types.js';
import type { Settings } from '../config/schema.js';
import type { Chunk } from '../scan/chunk.js';
import { estimateJsonTokens } from '../util/tokens.js';

/** Leaves room for wire overhead and any server-side framing inside the context window. */
const CONTEXT_SAFETY = 0.9;

export interface QuestionBinding {
  key: string;
  check: Check;
}

export interface RequestPlan {
  state: Record<string, unknown>;
  questions: Record<string, QuestionSpec>;
  bindings: QuestionBinding[];
  stateTokens: number;
  questionTokens: number;
  /** The state alone exceeds the usable context; this request is expected to be rejected. */
  oversized?: boolean;
}

/**
 * Question ids are for code only - the model never sees them - so a mangled id costs nothing as long
 * as the mapping back to the check is exact.
 */
export function questionKeyFor(checkId: string): string {
  return `q_${checkId.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function matchesGlobs(globs: readonly string[], paths: readonly string[]): boolean {
  const matcher = ignoreFactory().add([...globs]);
  return paths.some((p) => matcher.ignores(p));
}

export function applicableChecks(chunk: Chunk, checks: readonly Check[]): Check[] {
  const paths = chunk.files.map((f) => f.path);
  return checks.filter((check) => {
    if (check.scope !== 'chunk') return false;
    if (check.languages && !check.languages.includes(chunk.language)) return false;
    if (check.appliesTo && check.appliesTo.length > 0 && !matchesGlobs(check.appliesTo, paths)) return false;
    return true;
  });
}

function withAppendedContext(instructions: InstructionsValue, extra: string | undefined): InstructionsValue {
  if (!extra?.trim()) return instructions;
  if (typeof instructions === 'string') return `${instructions}\n\nProject note: ${extra.trim()}`;
  return { ...instructions, project_note: extra.trim() };
}

export function buildQuestionSpec(check: Check, settings: Settings): QuestionSpec {
  const spec: QuestionSpec = {
    type: check.type,
    instructions: withAppendedContext(check.instructions, settings.prompts.append[check.id]),
  };
  if (check.criteria) spec.criteria = check.criteria;
  return spec;
}

export function buildState(chunk: Chunk, settings: Settings): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (settings.prompts.projectContext.trim()) state.project_context = settings.prompts.projectContext.trim();
  state.language = chunk.language;
  state.files = chunk.files.map((file) => ({
    path: file.path,
    start_line: file.startLine,
    content: file.content,
  }));
  return state;
}

/**
 * One request per chunk wherever the context allows it: questions are answered in parallel and the
 * state is only paid for once, so splitting is a last resort rather than a default.
 */
export function planRequests(
  chunk: Chunk,
  checks: readonly Check[],
  settings: Settings,
  contextTokens: number,
): RequestPlan[] {
  const applicable = applicableChecks(chunk, checks);
  if (applicable.length === 0) return [];

  const state = buildState(chunk, settings);
  const stateTokens = estimateJsonTokens(state);
  const usable = Math.floor(contextTokens * CONTEXT_SAFETY);
  const budget = usable - stateTokens;

  const specs = applicable.map((check) => {
    const key = questionKeyFor(check.id);
    const spec = buildQuestionSpec(check, settings);
    return { check, key, spec, tokens: estimateJsonTokens({ [key]: spec }) };
  });

  // If not even the smallest question fits beside the state, no split can succeed - every request
  // would carry the same oversized state. Ask once, so the run fails loudly and cheaply, not N times.
  const smallestQuestion = Math.min(...specs.map((item) => item.tokens));
  const oversized = budget <= 0 || smallestQuestion > budget;

  const plans: RequestPlan[] = [];
  let batch: typeof specs = [];
  let batchTokens = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    const questions: Record<string, QuestionSpec> = {};
    for (const item of batch) questions[item.key] = item.spec;
    plans.push({
      state,
      questions,
      bindings: batch.map((item) => ({ key: item.key, check: item.check })),
      stateTokens,
      questionTokens: estimateJsonTokens(questions),
      ...(oversized ? { oversized: true } : {}),
    });
    batch = [];
    batchTokens = 0;
  };

  for (const item of specs) {
    if (!oversized && batch.length > 0 && batchTokens + item.tokens > budget) flush();
    batch.push(item);
    batchTokens += item.tokens;
  }
  flush();

  return plans;
}
