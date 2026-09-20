import fs from 'node:fs/promises';
import path from 'node:path';

import { configError } from '../errors.js';
import { parseJsonc } from './jsonc.js';
import { findProjectConfigDir, SETTINGS_FILE_NAME, userSettingsPath } from './paths.js';
import { crossValidate, mergeRawLayers, parseSettingsLayer, settingsSchema, type Settings } from './schema.js';

export interface LoadConfigOptions {
  cwd: string;
  /** File or directory to audit; defaults to the working directory. */
  target?: string;
  configFile?: string;
  /** Raw partial settings from CLI flags, applied last. */
  overrides?: Record<string, unknown>;
}

export interface LoadedConfig {
  settings: Settings;
  /** Project root: the directory holding `.isojevdit/`, else the target directory. */
  root: string;
  targetPath: string;
  targetIsFile: boolean;
  projectConfigDir?: string;
  /** Every layer that contributed, in application order. */
  sources: string[];
  warnings: string[];
}

async function readRawLayer(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw configError(`could not read ${file}: ${(err as Error).message}`);
  }
  try {
    const parsed = parseJsonc(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object at the top level');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw configError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function numberFromEnv(name: string, errors: string[]): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    errors.push(`${name} is not a number: ${raw}`);
    return undefined;
  }
  return value;
}

function envLayer(errors: string[]): Record<string, unknown> {
  const layer: Record<string, unknown> = {};
  const provider = process.env.ISO_JEVDIT_PROVIDER?.trim();
  const model = process.env.ISO_JEVDIT_MODEL?.trim();
  const concurrency = numberFromEnv('ISO_JEVDIT_CONCURRENCY', errors);
  const maxSpend = numberFromEnv('ISO_JEVDIT_MAX_SPEND', errors);

  if (provider) layer.provider = provider;
  if (concurrency !== undefined) layer.concurrency = concurrency;
  if (maxSpend !== undefined) layer.maxSpendUsd = maxSpend;
  if (model) {
    // Without knowing the active provider yet, the override lands on whichever one wins later.
    layer.__envModel = model;
  }
  return layer;
}

export async function loadConfig(opts: LoadConfigOptions): Promise<LoadedConfig> {
  const targetPath = path.resolve(opts.cwd, opts.target ?? '.');

  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch {
    throw configError(`no such file or directory: ${targetPath}`);
  }
  const targetIsFile = stat.isFile();
  if (!targetIsFile && !stat.isDirectory()) {
    throw configError(`not a file or directory: ${targetPath}`);
  }

  const searchStart = targetIsFile ? path.dirname(targetPath) : targetPath;
  const projectDir = findProjectConfigDir(searchStart);
  const root = projectDir ? path.dirname(projectDir) : searchStart;

  const errors: string[] = [];
  const warnings: string[] = [];
  const sources: string[] = ['built-in defaults'];
  const rawLayers: Array<Record<string, unknown>> = [];

  const fileLayers: Array<{ label: string; file: string }> = [{ label: 'user settings', file: userSettingsPath() }];
  if (projectDir) fileLayers.push({ label: 'project settings', file: path.join(projectDir, SETTINGS_FILE_NAME) });
  if (opts.configFile) fileLayers.push({ label: '--config', file: path.resolve(opts.cwd, opts.configFile) });

  for (const layer of fileLayers) {
    const raw = await readRawLayer(layer.file);
    if (!raw) {
      if (layer.label === '--config') throw configError(`--config file not found: ${layer.file}`);
      continue;
    }
    // Parsed per layer so a warning can name the file the typo is in.
    const parsed = parseSettingsLayer(raw, layer.file);
    warnings.push(...parsed.warnings);
    errors.push(...parsed.errors);
    rawLayers.push(raw);
    sources.push(layer.file);
  }

  const env = envLayer(errors);
  const envModel = typeof env.__envModel === 'string' ? env.__envModel : undefined;
  delete env.__envModel;
  if (Object.keys(env).length > 0 || envModel) {
    rawLayers.push(env);
    sources.push('environment');
  }

  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    rawLayers.push(opts.overrides);
    sources.push('command line');
  }

  if (errors.length > 0) {
    throw configError(`invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }

  const merged = mergeRawLayers(rawLayers);
  const result = settingsSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where} - ${issue.message}`;
    });
    throw configError(`invalid configuration:\n  - ${issues.join('\n  - ')}`);
  }

  const settings = result.data;
  if (envModel) {
    const active = settings.provider;
    settings.providers[active] = { ...(settings.providers[active] ?? { headers: {} }), model: envModel };
  }

  const crossErrors = crossValidate(settings);
  if (crossErrors.length > 0) {
    throw configError(`invalid configuration:\n  - ${crossErrors.join('\n  - ')}`);
  }

  for (const [name, provider] of Object.entries(settings.providers)) {
    if (provider.apiKey) {
      warnings.push(
        `providers.${name}.apiKey is set in settings.json, which is normally committed. Move it with:  iso-jevdit --provider=${name} --key=<key>`,
      );
    }
  }

  return {
    settings,
    root,
    targetPath,
    targetIsFile,
    ...(projectDir ? { projectConfigDir: projectDir } : {}),
    sources,
    warnings,
  };
}
