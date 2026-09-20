import path from 'node:path';

import { CONFIG_DIR_NAME, SCHEMA_FILE_NAME, SETTINGS_FILE_NAME } from '../config/paths.js';
import { settingsSchema } from '../config/schema.js';
import { EXIT, type ExitCode } from '../errors.js';
import { ensureDir, pathExists, writeFileAtomic } from '../util/fs.js';
import { log } from '../util/logger.js';

const SETTINGS_TEMPLATE = `{
  "$schema": "./${SCHEMA_FILE_NAME}",

  // Which provider to use. Keys are NOT stored here - they live in
  // ~/.isojevdit/credentials.json, written by:  iso-jevdit --provider=openrouter --key=<key>
  "provider": "openrouter",

  // Paths to leave out. A bare name matches that directory at any depth;
  // a name with a slash is relative to this project's root.
  "ignoreDirs": [".vscode", ".idea", ".config"],

  // Gitignore-style globs, for finer cuts than a whole directory.
  "ignore": [],

  // Globs that override every ignore rule above, including .gitignore.
  "unignore": [],

  // File types to audit on top of the shipped list (which covers php, js, ts, py, go, ...).
  "extraExtensions": [],

  // Confidence policy. "report" is the floor for a finding to appear at all;
  // at or above "high" it keeps its full severity, between the two it is demoted.
  "thresholds": {
    "report": 0.6,
    "high": 0.8
  },

  // Facts about this project, added to every question. This is the cheapest way to
  // stop false positives: say what is already safe and why.
  "prompts": {
    "projectContext": "",
    "append": {}
  },

  // Stop the run before it can spend more than this. --estimate prints the forecast.
  "maxSpendUsd": 1.0,

  // Fail CI at this severity or worse. Use "none" to always exit 0.
  "failOn": "high"
}
`;

const GITIGNORE_TEMPLATE = `# Cached decisions: derived data, and large.
cache/

# Belt and braces: keys belong in ~/.isojevdit/credentials.json, never in a repo.
credentials.json
`;

export interface InitOptions {
  root: string;
  force?: boolean;
}

export async function runInit(opts: InitOptions): Promise<ExitCode> {
  const dir = path.join(opts.root, CONFIG_DIR_NAME);
  await ensureDir(dir, 0o755);

  const settingsFile = path.join(dir, SETTINGS_FILE_NAME);
  const schemaFile = path.join(dir, SCHEMA_FILE_NAME);
  const gitignoreFile = path.join(dir, '.gitignore');

  const written: string[] = [];
  const kept: string[] = [];

  if (!opts.force && (await pathExists(settingsFile))) {
    kept.push(settingsFile);
  } else {
    await writeFileAtomic(settingsFile, SETTINGS_TEMPLATE);
    written.push(settingsFile);
  }

  // Generated rather than hand-written, so editor autocomplete can never drift from the real schema.
  try {
    const jsonSchema = (settingsSchema as unknown as { toJSONSchema?: () => unknown }).toJSONSchema?.() ?? null;
    const schema = jsonSchema ?? (await import('zod')).z.toJSONSchema(settingsSchema, { io: 'input' });
    await writeFileAtomic(schemaFile, `${JSON.stringify(schema, null, 2)}\n`);
    written.push(schemaFile);
  } catch (err) {
    log.detail(`could not generate ${SCHEMA_FILE_NAME}: ${(err as Error).message}`);
  }

  if (await pathExists(gitignoreFile)) kept.push(gitignoreFile);
  else {
    await writeFileAtomic(gitignoreFile, GITIGNORE_TEMPLATE);
    written.push(gitignoreFile);
  }

  log.blank();
  log.success(`Scaffolded ${CONFIG_DIR_NAME}/`);
  for (const file of written) log.kv('written', path.relative(opts.root, file).split(path.sep).join('/'));
  for (const file of kept) log.kv('kept', `${path.relative(opts.root, file).split(path.sep).join('/')} (already existed)`);
  log.blank();
  log.info('Next:');
  log.info('  iso-jevdit --provider=openrouter --key=<key>   store a credential');
  log.info('  iso-jevdit --estimate .                       forecast cost, no API calls');
  log.blank();
  return EXIT.ok;
}
