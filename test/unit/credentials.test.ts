import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllCredentials,
  clearKey,
  credentialsDirectory,
  getStoredKey,
  providersInFile,
  readCredentials,
  saveKey,
} from '../../src/config/credentials.js';
import { DEFAULT_SETTINGS } from '../../src/config/schema.js';
import { resolveApiKey, resolveProviderConfig, requireKey } from '../../src/providers/index.js';
import { createRedactor, maskKey, maskSecretsInText } from '../../src/report/redact.js';

const KEY = 'sk-or-v1-0123456789abcdefghijklmnopqrstuv';
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'isojevdit-cred-'));
  process.env.ISO_JEVDIT_HOME = tmp;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(async () => {
  delete process.env.ISO_JEVDIT_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('credentials file', () => {
  it('writes to ~/.isojevdit/credentials.json and reads back', async () => {
    const result = await saveKey('openrouter', KEY, { verified: true });

    expect(result.file).toBe(path.join(tmp, 'credentials.json'));
    expect(credentialsDirectory()).toBe(tmp);
    expect(result.masked).not.toContain('0123456789abcdef');
    expect(await getStoredKey('openrouter')).toBe(KEY);

    const onDisk = JSON.parse(await fs.readFile(result.file, 'utf8')) as Record<string, { lastVerifiedAt?: string }>;
    expect(onDisk.version).toBe(1);
    expect(onDisk.openrouter?.lastVerifiedAt).toBeTruthy();
  });

  it('reports whether it replaced an existing entry', async () => {
    expect((await saveKey('openrouter', KEY)).replaced).toBe(false);
    expect((await saveKey('openrouter', `${KEY}2`)).replaced).toBe(true);
    expect(await getStoredKey('openrouter')).toBe(`${KEY}2`);
  });

  it('keeps other providers when clearing one, and removes the file with the last', async () => {
    await saveKey('openrouter', KEY);
    await saveKey('typesafe', `${KEY}b`);

    const first = await clearKey('openrouter');
    expect(first.removed).toEqual(['openrouter']);
    expect(first.remaining).toEqual(['typesafe']);
    expect(first.fileRemoved).toBe(false);

    const second = await clearKey('typesafe');
    expect(second.fileRemoved).toBe(true);
    await expect(fs.access(second.file)).rejects.toThrow();
  });

  it('is idempotent when nothing is stored', async () => {
    const cleared = await clearKey('openrouter');
    expect(cleared.removed).toEqual([]);
    expect(cleared.fileRemoved).toBe(false);

    const all = await clearAllCredentials();
    expect(all.removed).toEqual([]);
  });

  it('clears every provider at once', async () => {
    await saveKey('openrouter', KEY);
    await saveKey('typesafe', `${KEY}b`);
    const all = await clearAllCredentials();
    expect(all.removed.sort()).toEqual(['openrouter', 'typesafe']);
    expect(providersInFile(await readCredentials())).toEqual([]);
  });

  it('refuses a corrupt file with a recoverable message', async () => {
    await fs.writeFile(path.join(tmp, 'credentials.json'), '{ not json');
    await expect(readCredentials()).rejects.toThrow(/not valid JSON/);
  });
});

describe('key resolution order', () => {
  const provider = () => resolveProviderConfig(DEFAULT_SETTINGS);

  it('prefers the flag, then the environment, then the file', async () => {
    await saveKey('openrouter', KEY);
    expect((await resolveApiKey(provider(), 'flag-key')).source).toBe('flag');

    process.env.OPENROUTER_API_KEY = 'env-key';
    expect((await resolveApiKey(provider())).source).toBe('env');

    delete process.env.OPENROUTER_API_KEY;
    const fromFile = await resolveApiKey(provider());
    expect(fromFile.source).toBe('credentials');
    expect(fromFile.key).toBe(KEY);
  });

  it('falls back to a hand-edited settings.json key', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providers: { openrouter: { headers: {}, apiKey: KEY } },
    };
    const resolution = await resolveApiKey(resolveProviderConfig(settings));
    expect(resolution.source).toBe('settings');
  });

  it('explains how to supply a key when there is none', async () => {
    const resolution = await resolveApiKey(provider());
    expect(resolution.key).toBeUndefined();
    try {
      requireKey(provider(), resolution);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('no credential for provider "openrouter"');
      expect((err as { exitCode: number }).exitCode).toBe(3);
    }
  });
});

describe('redaction', () => {
  it('keeps only the first 8 and last 4 characters of a key', () => {
    const masked = maskKey(KEY);
    expect(masked.startsWith('sk-or-v1')).toBe(true);
    expect(masked.endsWith(KEY.slice(-4))).toBe(true);
    expect(masked).not.toContain('0123456789abcdefghij');
  });

  it('masks secret-shaped values in arbitrary text', () => {
    const text = `key = "${KEY}"\npassword: 'Pr0d!pass2024'\nAKIAIOSFODNN7EXAMPLE`;
    const masked = maskSecretsInText(text);
    expect(masked).not.toContain('0123456789abcdefghij');
    expect(masked).not.toContain('Pr0d!pass2024');
    expect(masked).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('masks a known secret even when no pattern recognises it', () => {
    const redact = createRedactor(['hunter2-not-a-known-shape']);
    expect(redact('token=hunter2-not-a-known-shape')).not.toContain('hunter2-not-a-known-shape');
  });
});
