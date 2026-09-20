import type { QuestionSpec } from '../checks/types.js';
import { IsoJevditError, EXIT } from '../errors.js';
import { maskSecretsInText } from '../report/redact.js';
import { log } from '../util/logger.js';
import type { ProviderDefaults } from './defaults.js';
import type { DecisionProvider, DecisionRequest, DecisionResponse, KeyCheck, Pricing, ProviderEvent, Usage } from './types.js';

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  headers: Record<string, string>;
  defaults: ProviderDefaults;
  rateLimitWaitMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

class RetryableError extends Error {
  readonly retryAfterMs?: number;
  readonly rateLimited: boolean;
  constructor(message: string, retryAfterMs?: number, rateLimited = false) {
    super(message);
    this.name = 'RetryableError';
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    this.rateLimited = rateLimited;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 30_000);
  const base = Math.min(500 * 2 ** attempt, 20_000);
  return base + Math.random() * 250;
}

/** Response bodies can echo request content, so anything quoted back is redacted first. */
function shortBody(text: string): string {
  const flat = maskSecretsInText(text).replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

/**
 * TypeSafe accepts structured instructions and criteria, but OpenRouter's Decisions router validates
 * both as strings, so structured values are JSON-encoded here - at the transport boundary, where the
 * limitation actually lives. A null criteria definition becomes the label name, which carries the
 * same information the model would otherwise infer from the name alone.
 */
function encodeQuestionsForWire(questions: Record<string, QuestionSpec>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    const wire: Record<string, unknown> = {
      type: question.type,
      instructions: typeof question.instructions === 'string' ? question.instructions : JSON.stringify(question.instructions),
    };
    if (question.criteria) {
      const criteria: Record<string, string> = {};
      for (const [label, definition] of Object.entries(question.criteria)) {
        criteria[label] =
          definition === null
            ? label.replace(/_/g, ' ')
            : typeof definition === 'string'
              ? definition
              : JSON.stringify(definition);
      }
      wire.criteria = criteria;
    }
    encoded[key] = wire;
  }
  return encoded;
}

function readUsage(raw: unknown): Usage {
  const usage = (raw as { usage?: Record<string, unknown> } | undefined)?.usage ?? {};
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
  };
  const cost = num('cost', 'total_cost');
  return {
    inputTokens: num('input_tokens', 'prompt_tokens', 'inputTokens'),
    outputTokens: num('output_tokens', 'completion_tokens', 'outputTokens'),
    ...(cost > 0 ? { costUsd: cost } : {}),
  };
}

/**
 * Talks the Decisions wire format directly. Deliberately not the generated SDK: this endpoint is in
 * alpha, and an audit run must decide for itself what a malformed response means rather than trust a
 * client's assumptions about a shape that is still moving.
 */
export class OpenRouterProvider implements DecisionProvider {
  readonly name = 'openrouter';
  readonly model: string;
  readonly contextTokens: number;
  readonly pricing: Pricing;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly defaults: ProviderDefaults;
  private readonly rateLimitWaitMs: number;

  constructor(opts: OpenRouterOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries;
    this.extraHeaders = opts.headers;
    this.defaults = opts.defaults;
    this.rateLimitWaitMs = opts.rateLimitWaitMs ?? 10_000;
    this.contextTokens = opts.defaults.contextTokens;
    this.pricing = opts.defaults.pricing;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'iso-jevdit',
      ...this.extraHeaders,
    };
  }

  private async request(pathname: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await fetch(`${this.baseUrl}${pathname}`, { ...init, headers: this.headers(), signal: combined });
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = (err as Error).name === 'TimeoutError' ? `no response in ${this.timeoutMs}ms` : (err as Error).message;
      throw new RetryableError(reason);
    }
  }

  async verifyKey(): Promise<KeyCheck> {
    const pathname = this.defaults.keyCheckPath;
    if (!pathname) return { ok: true, detail: 'not checked (this provider has no key endpoint)' };

    let response: Response;
    try {
      response = await this.request(pathname, { method: 'GET' });
    } catch (err) {
      return { ok: false, detail: `could not reach ${this.baseUrl}: ${(err as Error).message}` };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: 'the provider rejected this key' };
    }
    if (!response.ok) {
      return { ok: false, detail: `the key endpoint answered ${response.status}` };
    }

    const body = (await response.json().catch(() => undefined)) as { data?: Record<string, unknown> } | undefined;
    const data = body?.data ?? {};
    const label = typeof data.label === 'string' && data.label ? data.label : undefined;
    const limit = data.limit_remaining;
    const parts = ['accepted'];
    if (label) parts.push(`label "${label}"`);
    if (typeof limit === 'number') parts.push(`${limit} credits remaining`);
    else if (limit === null) parts.push('no credit limit');
    return { ok: true, detail: parts.join(', ') };
  }

  async decide(
    request: DecisionRequest,
    opts: { signal?: AbortSignal; onEvent?: (event: ProviderEvent) => void } = {},
  ): Promise<DecisionResponse> {
    const body = JSON.stringify({
      model: request.model,
      state: request.state,
      questions: encodeQuestionsForWire(request.questions),
    });

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const retryable = lastError instanceof RetryableError ? lastError : undefined;
        const rateLimited = retryable?.rateLimited === true;
        const wait = rateLimited
          ? Math.max(this.rateLimitWaitMs, retryable?.retryAfterMs ?? 0)
          : backoffMs(attempt - 1, retryable?.retryAfterMs);
        opts.onEvent?.({
          type: rateLimited ? 'rate-limit' : 'retry',
          attempt,
          maxRetries: this.maxRetries,
          waitMs: wait,
          detail: lastError?.message ?? 'unknown provider error',
        });
        log.detail(`retry ${attempt}/${this.maxRetries} in ${Math.round(wait)}ms (${lastError?.message ?? 'unknown'})`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      try {
        const response = await this.request(this.defaults.decisionsPath, { method: 'POST', body }, opts.signal);

        if (response.status === 401 || response.status === 403) {
          const text = await response.text().catch(() => '');
          throw new IsoJevditError(`the provider rejected the API key (${response.status})`, EXIT.credential, [
            `Check the key at ${this.defaults.keyHint}, then re-save it with:  iso-jevdit --provider=${this.name} --key=<key>`,
            ...(text ? [shortBody(text)] : []),
          ]);
        }
        if (response.status === 404) {
          const text = await response.text().catch(() => '');
          throw new IsoJevditError(
            `${this.baseUrl}${this.defaults.decisionsPath} returned 404 - the Decisions endpoint or the model id may have moved`,
            EXIT.credential,
            [`model: ${request.model}`, ...(text ? [shortBody(text)] : [])],
          );
        }
        if (RETRYABLE_STATUS.has(response.status)) {
          const text = await response.text().catch(() => '');
          throw new RetryableError(
            `${response.status} ${shortBody(text)}`,
            parseRetryAfter(response.headers.get('retry-after')),
            response.status === 429,
          );
        }
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`${response.status} ${shortBody(text)}`);
        }

        const parsed = (await response.json().catch(() => {
          throw new Error('the response body was not JSON');
        })) as unknown;

        const answers = (parsed as { answers?: unknown })?.answers;
        if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
          throw new Error('the response contained no "answers" object');
        }

        return { answers: answers as Record<string, unknown>, usage: readUsage(parsed) };
      } catch (err) {
        if (err instanceof IsoJevditError) throw err;
        if (opts.signal?.aborted) throw err;
        lastError = err as Error;
        if (!(err instanceof RetryableError)) break;
      }
    }

    throw new Error(`the decisions request failed: ${lastError?.message ?? 'unknown error'}`);
  }
}
