import { z } from 'zod';

const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
const probability = z.number().gt(0).max(1);

/**
 * Per-provider overrides. Every field is optional because the real defaults live in
 * providers/defaults.ts - keeping them in one place stops the two copies from drifting.
 */
const providerSettingsSchema = z.strictObject({
  apiKeyEnv: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).prefault({}),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  /** Tolerated for hand-edited files, but warned about: keys belong in credentials.json. */
  apiKey: z.string().min(1).optional(),
});

/** Matches the wire contract: a string, a structured object or array, or null. */
const criteriaValue = z.union([z.string(), z.null(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

const extraCheckSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  controls: z.array(z.string()).min(1),
  severity: severitySchema.default('medium'),
  scope: z.enum(['chunk', 'repo']).default('chunk'),
  appliesTo: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  type: z.enum(['choice', 'noul', 'score']).default('choice'),
  instructions: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  criteria: z.record(z.string(), criteriaValue).optional(),
  positiveLabels: z.array(z.string()).optional(),
  threshold: probability.optional(),
  requirement: z.string().optional(),
  why: z.string().optional(),
  impact: z.string().optional(),
  remediation: z.string().min(1),
  references: z.array(z.string()).default([]),
});

export const settingsSchema = z.strictObject({
  $schema: z.string().optional(),

  provider: z.string().min(1).default('openrouter'),
  providers: z.record(z.string(), providerSettingsSchema).prefault({}),

  /** Unset means the shipped extension list; setting it replaces that list outright. */
  extensions: z.array(z.string()).optional(),
  extraExtensions: z.array(z.string()).default([]),
  filenames: z.array(z.string()).optional(),

  ignoreDirs: z.array(z.string()).default([]),
  ignore: z.array(z.string()).default([]),
  unignore: z.array(z.string()).default([]),
  ignoreDefaults: z.boolean().default(true),
  includeDotDirs: z.array(z.string()).default([]),
  respectGitignore: z.boolean().default(true),
  maxFileSizeKb: z.number().int().min(1).default(512),
  followSymlinks: z.boolean().default(false),

  chunk: z
    .strictObject({
      maxTokens: z.number().int().min(500).max(28_000).default(8000),
      overlapLines: z.number().int().min(0).max(200).default(20),
      pack: z.boolean().default(false),
      packSameDirOnly: z.boolean().default(true),
    })
    .prefault({}),

  localize: z
    .strictObject({
      enabled: z.boolean().default(true),
      slices: z.number().int().min(2).max(8).default(3),
      maxDepth: z.number().int().min(0).max(4).default(2),
      minLines: z.number().int().min(1).default(12),
    })
    .prefault({}),

  concurrency: z.number().int().min(1).max(32).default(4),
  maxSpendUsd: z.number().min(0).default(10),

  thresholds: z
    .strictObject({
      report: probability.default(0.6),
      high: probability.default(0.8),
      perCheck: z.record(z.string(), probability).prefault({}),
    })
    .prefault({}),

  severityOverrides: z.record(z.string(), severitySchema).prefault({}),

  checks: z
    .strictObject({
      include: z.array(z.string()).default(['*']),
      exclude: z.array(z.string()).default([]),
    })
    .prefault({}),
  extraChecks: z.array(extraCheckSchema).default([]),

  prompts: z
    .strictObject({
      projectContext: z.string().default(''),
      append: z.record(z.string(), z.string()).prefault({}),
    })
    .prefault({}),

  report: z
    .strictObject({
      out: z.string().min(1).default('iso-jevdit-report.md'),
      json: z.boolean().default(true),
      includePassed: z.boolean().default(true),
      includeConfig: z.boolean().default(true),
      snippetLines: z.number().int().min(0).max(80).default(6),
      maxFindingsPerCheck: z.number().int().min(1).default(50),
      groupBy: z.enum(['control', 'file', 'severity']).default('control'),
      timestamp: z.boolean().default(true),
    })
    .prefault({}),

  cache: z
    .strictObject({
      enabled: z.boolean().default(true),
      dir: z.string().min(1).default('.isojevdit/cache'),
      ttlDays: z.number().int().min(1).default(30),
    })
    .prefault({}),

  waivers: z.string().min(1).default('.isojevdit/waivers.json'),
  failOn: z.union([severitySchema, z.literal('none')]).default('high'),
  redactSecrets: z.boolean().default(true),
});

export type Settings = z.infer<typeof settingsSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type ExtraCheckSettings = z.infer<typeof extraCheckSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/** Arrays that add to what earlier layers (and the shipped defaults) already contain. */
const APPENDING_ARRAYS = new Set(['ignore', 'ignoreDirs', 'unignore', 'extraExtensions', 'extraChecks', 'includeDotDirs']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges raw layers before any defaults are applied, so an appending array accumulates across
 * files instead of each layer's default wiping the last.
 */
export function mergeRawLayers(layers: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  const merge = (base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(next)) {
      const existing = out[key];
      if (isPlainObject(existing) && isPlainObject(value)) {
        out[key] = merge(existing, value);
      } else if (Array.isArray(existing) && Array.isArray(value) && APPENDING_ARRAYS.has(key)) {
        out[key] = [...existing, ...value];
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  return layers.reduce<Record<string, unknown>>((acc, layer) => merge(acc, layer), {});
}

export interface LayerParseResult {
  settings: Settings;
  /** Unknown keys, with the nearest valid sibling suggested. */
  warnings: string[];
  errors: string[];
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = new Array(rows * cols).fill(0);
  for (let i = 0; i < rows; i += 1) d[i * cols] = i;
  for (let j = 0; j < cols; j += 1) d[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i * cols + j] = Math.min(d[(i - 1) * cols + j]! + 1, d[i * cols + (j - 1)]! + 1, d[(i - 1) * cols + (j - 1)]! + cost);
    }
  }
  return d[rows * cols - 1]!;
}

function nearestKey(unknown: string, candidates: string[]): string | undefined {
  let best: { key: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(unknown.toLowerCase(), candidate.toLowerCase());
    if (!best || distance < best.distance) best = { key: candidate, distance };
  }
  if (!best) return undefined;
  return best.distance <= Math.max(2, Math.ceil(unknown.length / 3)) ? best.key : undefined;
}

function valueAtPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function deleteAtPath(root: Record<string, unknown>, path: ReadonlyArray<string | number>, keys: string[]): void {
  const target = valueAtPath(root, path);
  if (!isPlainObject(target)) return;
  for (const key of keys) delete target[key];
}

/**
 * Parses one settings layer. Unknown keys are stripped with a warning (a typo should not stop an
 * audit), while an invalid value is an error the caller turns into exit 2.
 */
export function parseSettingsLayer(raw: unknown, sourceLabel: string): LayerParseResult {
  if (!isPlainObject(raw)) {
    return { settings: DEFAULT_SETTINGS, warnings: [], errors: [`${sourceLabel}: expected a JSON object at the top level`] };
  }

  const warnings: string[] = [];
  const working: Record<string, unknown> = structuredClone(raw);

  // Unknown keys come back as their own issue kind, so they can be reported and removed without
  // losing the rest of the file.
  for (let pass = 0; pass < 8; pass += 1) {
    const result = settingsSchema.safeParse(working);
    if (result.success) {
      // Suggestions read best against the fully populated object.
      return { settings: result.data, warnings, errors: [] };
    }

    const unrecognized = result.error.issues.filter((issue) => issue.code === 'unrecognized_keys');
    const others = result.error.issues.filter((issue) => issue.code !== 'unrecognized_keys');
    if (unrecognized.length === 0 || others.length > 0) {
      const errors = others.map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${sourceLabel}: ${where} - ${issue.message}`;
      });
      return { settings: DEFAULT_SETTINGS, warnings, errors };
    }

    for (const issue of unrecognized) {
      const keys = (issue as unknown as { keys: string[] }).keys;
      const parentPath = issue.path.map((p) => p as string | number);
      // Only suggest siblings we can actually enumerate; a record such as providers.<name> has none in
      // the defaults, and guessing there would point at unrelated top-level keys.
      const parent = parentPath.length > 0 ? valueAtPath(DEFAULT_SETTINGS, parentPath) : DEFAULT_SETTINGS;
      const validSiblings = isPlainObject(parent) ? Object.keys(parent) : [];
      for (const key of keys) {
        const where = parentPath.length > 0 ? `${parentPath.join('.')}.${key}` : key;
        const suggestion = validSiblings.length > 0 ? nearestKey(key, validSiblings) : undefined;
        warnings.push(`${sourceLabel}: unknown setting "${where}"${suggestion ? ` - did you mean "${suggestion}"?` : ''} (ignored)`);
      }
      deleteAtPath(working, parentPath, keys);
    }
  }

  return { settings: DEFAULT_SETTINGS, warnings, errors: [`${sourceLabel}: could not be parsed after removing unknown keys`] };
}

/** Relationships between settings that a field-level schema cannot express. */
export function crossValidate(settings: Settings): string[] {
  const errors: string[] = [];

  if (settings.thresholds.high < settings.thresholds.report) {
    errors.push(
      `thresholds.high (${settings.thresholds.high}) must be at least thresholds.report (${settings.thresholds.report}): a finding cannot earn full severity below the threshold that reports it`,
    );
  }

  for (const [name, provider] of Object.entries(settings.providers)) {
    if (provider.baseUrl !== undefined) {
      try {
        new URL(provider.baseUrl);
      } catch {
        errors.push(`providers.${name}.baseUrl is not a valid URL: ${provider.baseUrl}`);
      }
    }
  }

  const ids = new Set<string>();
  for (const check of settings.extraChecks) {
    if (ids.has(check.id)) errors.push(`extraChecks contains two checks with id "${check.id}"`);
    ids.add(check.id);
  }

  return errors;
}
