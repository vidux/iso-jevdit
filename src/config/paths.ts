import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR_NAME = '.isojevdit';
export const SETTINGS_FILE_NAME = 'settings.json';
export const CREDENTIALS_FILE_NAME = 'credentials.json';
export const SCHEMA_FILE_NAME = 'schema.json';
export const RUN_STATUS_FILE_NAME = 'last-run.json';

/** ISO_JEVDIT_HOME exists so tests never touch a real user's credentials. */
export function isoJevditHome(): string {
  const override = process.env.ISO_JEVDIT_HOME;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

export function credentialsPath(): string {
  return path.join(isoJevditHome(), CREDENTIALS_FILE_NAME);
}

export function userSettingsPath(): string {
  return path.join(isoJevditHome(), SETTINGS_FILE_NAME);
}

export function projectConfigDir(root: string): string {
  return path.join(root, CONFIG_DIR_NAME);
}

/**
 * Same directory on disk? Compared by identity rather than by string, because on Windows the same
 * directory reaches us in different forms - 8.3 short names (USERNA~1 vs the full name), differing case,
 * junctions - and a string compare would quietly answer no.
 */
function isSameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  if (process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()) return true;
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.dev === right.dev && left.ino === right.ino && left.ino !== 0;
  } catch {
    return false;
  }
}

/**
 * Nearest ancestor of `startDir` that contains a `.isojevdit/` directory.
 *
 * The user-level config directory carries the same name, so it is skipped. Without that, anyone who
 * had saved a credential would see the scan root jump to their home directory for every project under
 * it without a `.isojevdit` of its own, which moves the report out of the project and re-bases every
 * ignore rule against the wrong directory.
 */
export function findProjectConfigDir(startDir: string): string | undefined {
  const userDir = path.resolve(isoJevditHome());
  const home = path.resolve(os.homedir());
  let current = path.resolve(startDir);
  for (;;) {
    // The search stops at the home directory. A `.isojevdit` there is the user-level config, not a
    // project, and anything above it belongs to no project at all - so the scan root can never
    // escape into the home directory and drag the report and the ignore rules with it.
    if (isSameDirectory(current, home)) return undefined;

    const candidate = path.join(current, CONFIG_DIR_NAME);
    try {
      if (fs.statSync(candidate).isDirectory() && !isSameDirectory(candidate, userDir)) return candidate;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Display form for paths in messages: absolute, native separators. */
export function displayPath(target: string): string {
  return path.resolve(target);
}
