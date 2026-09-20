import type { Pricing } from './types.js';

export interface ProviderDefaults {
  baseUrl: string;
  model: string;
  /** `decisions` speaks the typed-decision wire format; `chat-emulated` is not implemented yet. */
  transport: 'decisions' | 'chat-emulated';
  decisionsPath: string;
  keyCheckPath?: string;
  contextTokens: number;
  pricing: Pricing;
  apiKeyEnv: string;
  timeoutMs: number;
  maxRetries: number;
  keyHint: string;
}

export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai',
    model: '~typesafe/jev-latest',
    transport: 'decisions',
    decisionsPath: '/api/alpha/decisions',
    keyCheckPath: '/api/v1/key',
    contextTokens: 32_000,
    // Jev on OpenRouter as of 2026-09: input billed, output free.
    pricing: { inputPerMTok: 0.042, outputPerMTok: 0 },
    apiKeyEnv: 'OPENROUTER_API_KEY',
    timeoutMs: 60_000,
    maxRetries: 4,
    keyHint: 'https://openrouter.ai/keys',
  },
};

export function knownProviders(): string[] {
  return Object.keys(PROVIDER_DEFAULTS);
}

export function providerDefaults(name: string): ProviderDefaults | undefined {
  return PROVIDER_DEFAULTS[name];
}
