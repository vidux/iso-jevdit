import fs from 'node:fs/promises';
import path from 'node:path';

import { credentialError } from '../errors.js';
import { maskKey } from '../report/redact.js';
import { ensureDir, pathExists, removeFileIfExists, restrictToCurrentUser, writeFileAtomic } from '../util/fs.js';
import { credentialsPath, isoJevditHome } from './paths.js';

export interface CredentialEntry {
  apiKey: string;
  savedAt: string;
  lastVerifiedAt?: string;
  label?: string;
}

export interface CredentialsFile {
  version: 1;
  [provider: string]: CredentialEntry | 1;
}

const RESERVED_KEYS = new Set(['version']);

function isEntry(value: unknown): value is CredentialEntry {
  return typeof value === 'object' && value !== null && typeof (value as CredentialEntry).apiKey === 'string';
}

export async function readCredentials(): Promise<CredentialsFile> {
  const file = credentialsPath();
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 };
    throw credentialError(`could not read ${file}: ${(err as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return { version: 1, ...(parsed as Record<string, unknown>) } as CredentialsFile;
  } catch {
    throw credentialError(`${file} is not valid JSON`, [
      'Fix the file by hand, or start over with:  iso-jevdit --clear-credentials',
    ]);
  }
}

export function providersInFile(file: CredentialsFile): string[] {
  return Object.keys(file).filter((key) => !RESERVED_KEYS.has(key) && isEntry(file[key]));
}

export async function getStoredKey(provider: string): Promise<string | undefined> {
  const file = await readCredentials();
  const entry = file[provider];
  return isEntry(entry) ? entry.apiKey : undefined;
}

export interface SaveResult {
  file: string;
  masked: string;
  permissionDetail: string;
  restricted: boolean;
  replaced: boolean;
}

export async function saveKey(
  provider: string,
  apiKey: string,
  opts: { verified?: boolean; label?: string } = {},
): Promise<SaveResult> {
  const key = apiKey.trim();
  if (!key) throw credentialError('the key is empty');

  const file = credentialsPath();
  await ensureDir(isoJevditHome(), 0o700);

  const existing = await readCredentials();
  const previous = existing[provider];
  const entry: CredentialEntry = {
    apiKey: key,
    savedAt: new Date().toISOString(),
    ...(opts.verified ? { lastVerifiedAt: new Date().toISOString() } : {}),
    ...(opts.label ? { label: opts.label } : {}),
  };

  const next: Record<string, unknown> = { ...existing, version: 1, [provider]: entry };
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  const permissions = await restrictToCurrentUser(file);

  return {
    file,
    masked: maskKey(key),
    permissionDetail: permissions.detail,
    restricted: permissions.restricted,
    replaced: isEntry(previous),
  };
}

export interface ClearResult {
  file: string;
  removed: string[];
  remaining: string[];
  fileRemoved: boolean;
}

/** Removes one provider's entry. Deleting the last one removes the file as well. */
export async function clearKey(provider: string): Promise<ClearResult> {
  const file = credentialsPath();
  if (!(await pathExists(file))) return { file, removed: [], remaining: [], fileRemoved: false };

  const existing = await readCredentials();
  if (!isEntry(existing[provider])) {
    return { file, removed: [], remaining: providersInFile(existing), fileRemoved: false };
  }

  const next: Record<string, unknown> = { ...existing };
  delete next[provider];
  const remaining = providersInFile(next as CredentialsFile);

  if (remaining.length === 0) {
    await removeFileIfExists(file);
    return { file, removed: [provider], remaining: [], fileRemoved: true };
  }

  await writeFileAtomic(file, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, 0o600);
  await restrictToCurrentUser(file);
  return { file, removed: [provider], remaining, fileRemoved: false };
}

export async function clearAllCredentials(): Promise<ClearResult> {
  const file = credentialsPath();
  if (!(await pathExists(file))) return { file, removed: [], remaining: [], fileRemoved: false };
  const existing = await readCredentials();
  const removed = providersInFile(existing);
  await removeFileIfExists(file);
  return { file, removed, remaining: [], fileRemoved: true };
}

/** Reads a key from stdin, for `--key -`. */
export async function readKeyFromStdin(): Promise<string> {
  // Without this the process would sit on an interactive terminal forever, showing nothing.
  if (process.stdin.isTTY) {
    throw credentialError('--key - expects the key on stdin, but stdin is a terminal', [
      'PowerShell:  Get-Content key.txt | iso-jevdit --key -',
      'bash:        cat key.txt | iso-jevdit --key -',
    ]);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const key = Buffer.concat(chunks).toString('utf8').trim();
  if (!key) throw credentialError('no key arrived on stdin', ['Example:  type key.txt | iso-jevdit --key -']);
  return key;
}

export function credentialsDirectory(): string {
  return path.dirname(credentialsPath());
}
