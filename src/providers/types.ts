import type { QuestionSpec } from '../checks/types.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost when it sends one; otherwise the engine derives it from pricing. */
  costUsd?: number;
}

export interface DecisionRequest {
  model: string;
  state: unknown;
  questions: Record<string, QuestionSpec>;
}

export interface DecisionResponse {
  /** Raw, unvalidated answers keyed exactly as the request's questions. See jev/answers.ts. */
  answers: Record<string, unknown>;
  usage: Usage;
}

export interface KeyCheck {
  ok: boolean;
  detail: string;
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface DecisionProvider {
  readonly name: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly pricing: Pricing;
  verifyKey(): Promise<KeyCheck>;
  decide(request: DecisionRequest, opts?: { signal?: AbortSignal }): Promise<DecisionResponse>;
}

export function estimateCostUsd(usage: Usage, pricing: Pricing): number {
  if (usage.costUsd !== undefined) return usage.costUsd;
  return (usage.inputTokens / 1e6) * pricing.inputPerMTok + (usage.outputTokens / 1e6) * pricing.outputPerMTok;
}
