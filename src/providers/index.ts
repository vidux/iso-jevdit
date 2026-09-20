import { getStoredKey } from '../config/credentials.js';
import type { Settings } from '../config/schema.js';
import { configError, credentialError } from '../errors.js';
import { knownProviders, providerDefaults, type ProviderDefaults } from './defaults.js';
import { OpenRouterProvider } from './openrouter.js';
import type { DecisionProvider } from './types.js';

export interface ResolvedProvider {
  name: string;
  defaults: ProviderDefaults;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  headers: Record<string, string>;
  apiKeyEnv: string;
  /** Present only when someone hand-edited a key into settings.json. */
  settingsKey?: string;
}

/** Shipped defaults for the provider, with settings.json overrides applied. */
export function resolveProviderConfig(settings: Settings, nameOverride?: string): ResolvedProvider {
  const name = nameOverride ?? settings.provider;
  const defaults = providerDefaults(name);
  if (!defaults) {
    throw configError(`unknown provider "${name}"`, [`Known providers: ${knownProviders().join(', ')}`]);
  }
  const overrides = settings.providers[name];
  return {
    name,
    defaults,
    model: overrides?.model ?? defaults.model,
    baseUrl: overrides?.baseUrl ?? defaults.baseUrl,
    timeoutMs: overrides?.timeoutMs ?? defaults.timeoutMs,
    maxRetries: overrides?.maxRetries ?? defaults.maxRetries,
    headers: overrides?.headers ?? {},
    apiKeyEnv: overrides?.apiKeyEnv ?? defaults.apiKeyEnv,
    ...(overrides?.apiKey ? { settingsKey: overrides.apiKey } : {}),
  };
}

export type KeySource = 'flag' | 'env' | 'credentials' | 'settings';

export interface KeyResolution {
  key?: string;
  source?: KeySource;
  /** Where the key came from, for `--show-config` and the report header. */
  describe: string;
}

/** Flag, then environment, then the credentials file, then a legacy settings.json entry. */
export async function resolveApiKey(provider: ResolvedProvider, flagKey?: string): Promise<KeyResolution> {
  if (flagKey?.trim()) return { key: flagKey.trim(), source: 'flag', describe: '--key' };

  const fromEnv = process.env[provider.apiKeyEnv]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env', describe: `${provider.apiKeyEnv} environment variable` };

  const stored = await getStoredKey(provider.name);
  if (stored?.trim()) return { key: stored.trim(), source: 'credentials', describe: 'credentials.json' };

  if (provider.settingsKey?.trim()) {
    return { key: provider.settingsKey.trim(), source: 'settings', describe: 'settings.json (not recommended)' };
  }

  return { describe: 'not configured' };
}

export function requireKey(provider: ResolvedProvider, resolution: KeyResolution): string {
  if (resolution.key) return resolution.key;
  throw credentialError(`no credential for provider "${provider.name}"`, [
    `Save one:  iso-jevdit --provider=${provider.name} --key=<key>`,
    `Or set:    ${provider.apiKeyEnv}`,
    `Keys are issued at ${provider.defaults.keyHint}`,
  ]);
}

export function createProvider(provider: ResolvedProvider, apiKey: string): DecisionProvider {
  if (provider.defaults.transport === 'chat-emulated') {
    throw configError(`provider "${provider.name}" uses the chat-emulated transport, which is not implemented yet`);
  }
  switch (provider.name) {
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey,
        model: provider.model,
        baseUrl: provider.baseUrl,
        timeoutMs: provider.timeoutMs,
        maxRetries: provider.maxRetries,
        headers: provider.headers,
        defaults: provider.defaults,
      });
    default:
      throw configError(`no adapter is registered for provider "${provider.name}"`);
  }
}

export { knownProviders } from './defaults.js';
