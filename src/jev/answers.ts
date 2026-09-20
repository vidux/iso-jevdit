import { positiveLabelsOf, type Check } from '../checks/types.js';

export interface NormalizedAnswer {
  kind: 'choice' | 'noul' | 'score';
  /** The winning label, for choice answers. */
  choice?: string;
  /** Full distribution when the provider sends one; empty otherwise. */
  probabilities: Record<string, number>;
  /** How concentrated the distribution is - not a probability that the verdict is correct. */
  confidence?: number;
  score?: number;
}

export class AnswerShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerShapeError';
  }
}

function readProbabilities(raw: Record<string, unknown>): Record<string, number> {
  const source = raw.probabilities;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return {};
  const out: Record<string, number> = {};
  for (const [label, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[label] = value;
  }
  return out;
}

function readConfidence(raw: Record<string, unknown>): number | undefined {
  const value = raw.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The Decisions endpoint is in alpha, so every field is treated as untrusted: a shape this does not
 * recognise becomes a per-chunk tool error instead of a crash or, worse, a silently missing finding.
 */
export function normalizeAnswer(raw: unknown, check: Check): NormalizedAnswer {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AnswerShapeError(`answer for "${check.id}" was not an object`);
  }
  const record = raw as Record<string, unknown>;
  const declaredType = typeof record.type === 'string' ? record.type : undefined;

  // A noul answer can arrive as just { noul: 0.82 }, with no type field.
  if (declaredType === 'noul' || typeof record.noul === 'number') {
    const value = record.noul;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AnswerShapeError(`noul answer for "${check.id}" had no numeric value`);
    }
    return { kind: 'noul', probabilities: { yes: clamp01(value) }, ...(readConfidence(record) !== undefined ? { confidence: readConfidence(record) } : {}) };
  }

  if (declaredType === 'score' || typeof record.score === 'number') {
    const value = record.score;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AnswerShapeError(`score answer for "${check.id}" had no numeric value`);
    }
    return {
      kind: 'score',
      score: value,
      probabilities: readProbabilities(record),
      ...(readConfidence(record) !== undefined ? { confidence: readConfidence(record) } : {}),
    };
  }

  if (declaredType === 'choice' || typeof record.choice === 'string') {
    const choice = record.choice;
    if (typeof choice !== 'string' || choice.length === 0) {
      throw new AnswerShapeError(`choice answer for "${check.id}" had no choice`);
    }
    const known = Object.keys(check.criteria ?? {});
    if (known.length > 0 && !known.includes(choice)) {
      throw new AnswerShapeError(`choice answer for "${check.id}" was "${choice}", which is not one of its criteria`);
    }
    return {
      kind: 'choice',
      choice,
      probabilities: readProbabilities(record),
      ...(readConfidence(record) !== undefined ? { confidence: readConfidence(record) } : {}),
    };
  }

  throw new AnswerShapeError(`answer for "${check.id}" had no recognisable choice, noul or score`);
}

/**
 * The gate value. Probability mass on the violation labels is the right signal: `confidence` only
 * describes how concentrated the distribution is, so a confident "compliant" and a confident
 * "violation" carry the same confidence.
 */
export function positiveProbability(answer: NormalizedAnswer, check: Check): number {
  const positives = positiveLabelsOf(check);

  if (answer.kind === 'noul') return answer.probabilities.yes ?? 0;

  if (answer.kind === 'score') {
    const raw = answer.score ?? 0;
    return raw > 1 ? clamp01(raw / 10) : clamp01(raw);
  }

  if (Object.keys(answer.probabilities).length > 0) {
    return clamp01(positives.reduce((sum, label) => sum + (answer.probabilities[label] ?? 0), 0));
  }

  // No distribution came back: fall back to the winning label plus its confidence.
  if (answer.choice && positives.includes(answer.choice)) return answer.confidence ?? 1;
  return 0;
}
