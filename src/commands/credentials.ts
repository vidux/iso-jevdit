import { clearAllCredentials, clearKey, readCredentials, providersInFile } from '../config/credentials.js';
import { saveKey } from '../config/credentials.js';
import type { Settings } from '../config/schema.js';
import { credentialError, EXIT, type ExitCode } from '../errors.js';
import { createProvider, resolveApiKey, resolveProviderConfig } from '../providers/index.js';
import { maskKey } from '../report/redact.js';
import { log } from '../util/logger.js';

export interface SaveKeyOptions {
  settings: Settings;
  provider?: string;
  key: string;
  verify: boolean;
  /** False when the key arrived on stdin, which keeps it out of shell history. */
  fromCommandLine: boolean;
}

export async function runSaveKey(opts: SaveKeyOptions): Promise<ExitCode> {
  const provider = resolveProviderConfig(opts.settings, opts.provider);

  let verified = false;
  let verifiedDetail = 'not checked (--no-verify)';
  if (opts.verify) {
    const check = await createProvider(provider, opts.key).verifyKey();
    if (!check.ok) {
      throw credentialError(`the key was not saved: ${check.detail}`, [
        `Keys are issued at ${provider.defaults.keyHint}`,
        'To store it anyway, add --no-verify',
      ]);
    }
    verified = true;
    verifiedDetail = `yes (${check.detail})`;
  }

  const result = await saveKey(provider.name, opts.key, { verified });

  log.blank();
  log.success(result.replaced ? 'Credential replaced.' : 'Credential saved.');
  log.kv('provider', provider.name);
  log.kv('key', result.masked);
  log.kv('verified', verifiedDetail);
  log.kv('file', `${result.file}${result.restricted ? `  (${result.permissionDetail})` : ''}`);
  if (!result.restricted) {
    log.blank();
    log.warn(`the file could not be locked down: ${result.permissionDetail}`);
  }
  if (opts.fromCommandLine) {
    log.blank();
    log.info('  Note: --key was passed on the command line, so it is now in your shell history');
    log.info("        (PowerShell keeps PSReadLine's ConsoleHost_history.txt in plaintext).");
    log.info('        Next time:  Get-Content key.txt | iso-jevdit --key -');
  }
  log.blank();
  return EXIT.ok;
}

export async function runClearKey(settings: Settings, providerName?: string): Promise<ExitCode> {
  const provider = resolveProviderConfig(settings, providerName);
  const result = await clearKey(provider.name);

  log.blank();
  if (result.removed.length === 0) {
    log.info(`Nothing stored for provider "${provider.name}".`);
    log.kv('file', result.file);
  } else {
    log.success('Credential cleared.');
    log.kv('provider', provider.name);
    log.kv('file', result.file);
    log.kv('remaining', result.fileRemoved ? 'none (file removed)' : result.remaining.join(', '));
  }
  log.blank();
  return EXIT.ok;
}

export async function runClearCredentials(): Promise<ExitCode> {
  const result = await clearAllCredentials();

  log.blank();
  if (result.removed.length === 0) {
    log.info('No stored credentials to clear.');
    log.kv('file', result.file);
  } else {
    log.success(`Credentials cleared for ${result.removed.length} provider${result.removed.length === 1 ? '' : 's'}.`);
    log.kv('removed', result.removed.join(', '));
    log.kv('file', `${result.file} (removed)`);
  }
  log.blank();
  return EXIT.ok;
}

/** Everything that decided this run, with the key masked. */
export async function runShowConfig(settings: Settings, sources: string[], providerName?: string): Promise<ExitCode> {
  const provider = resolveProviderConfig(settings, providerName);
  const resolution = await resolveApiKey(provider);
  const stored = await readCredentials();

  const view = {
    sources,
    provider: {
      name: provider.name,
      model: provider.model,
      baseUrl: provider.baseUrl,
      contextTokens: provider.defaults.contextTokens,
      pricing: provider.defaults.pricing,
      apiKeyEnv: provider.apiKeyEnv,
      credential: {
        resolvedFrom: resolution.describe,
        key: resolution.key ? maskKey(resolution.key) : null,
      },
      storedFor: providersInFile(stored),
    },
    settings: {
      ...settings,
      providers: Object.fromEntries(
        Object.entries(settings.providers).map(([name, value]) => [
          name,
          { ...value, ...(value.apiKey ? { apiKey: maskKey(value.apiKey) } : {}) },
        ]),
      ),
    },
  };

  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  return EXIT.ok;
}
