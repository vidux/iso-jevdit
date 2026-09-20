import { createRequire } from 'node:module';

import { resolveChecks } from './checks/resolve.js';
import { runAudit } from './commands/audit.js';
import { runListChecks } from './commands/checks.js';
import { runClearCredentials, runClearKey, runSaveKey, runShowConfig } from './commands/credentials.js';
import { runInit } from './commands/init.js';
import { readKeyFromStdin } from './config/credentials.js';
import { loadConfig } from './config/load.js';
import { configError, EXIT, IsoJevditError, type ExitCode } from './errors.js';
import { knownProviders, resolveProviderConfig } from './providers/index.js';
import { explainIgnore } from './scan/discover.js';
import { configureLogger, log, out } from './util/logger.js';

type FlagKind = 'boolean' | 'string' | 'number' | 'optional-string' | 'array';

interface FlagSpec {
  name: string;
  kind: FlagKind;
  group: string;
  placeholder?: string;
  help: string;
}

const FLAGS: FlagSpec[] = [
  { name: 'provider', kind: 'string', group: 'Credentials', placeholder: '<name>', help: `provider to use (${knownProviders().join(', ')})` },
  { name: 'key', kind: 'string', group: 'Credentials', placeholder: '<key|->', help: 'store a key in ~/.isojevdit/credentials.json; "-" reads stdin' },
  { name: 'save', kind: 'boolean', group: 'Credentials', help: '--no-save uses --key for this run only' },
  { name: 'verify', kind: 'boolean', group: 'Credentials', help: '--no-verify skips the live key check when saving' },
  { name: 'clear-key', kind: 'optional-string', group: 'Credentials', placeholder: '[provider]', help: "remove one provider's stored key" },
  { name: 'clear-credentials', kind: 'boolean', group: 'Credentials', help: 'remove every stored key and delete the file' },
  { name: 'model', kind: 'string', group: 'Credentials', placeholder: '<id>', help: "override the provider's model" },

  { name: 'config', kind: 'string', group: 'Configuration', placeholder: '<file>', help: 'extra settings layer, highest file precedence' },
  { name: 'show-config', kind: 'boolean', group: 'Configuration', help: 'print the effective configuration (masked) and exit' },
  { name: 'init', kind: 'boolean', group: 'Configuration', help: 'scaffold .isojevdit/ in the project root' },
  { name: 'list-checks', kind: 'boolean', group: 'Configuration', help: 'list the selected checks and exit' },

  { name: 'checks', kind: 'array', group: 'Scope', placeholder: '<ids>', help: 'only these check ids or id globs (repeatable)' },
  { name: 'exclude-checks', kind: 'array', group: 'Scope', placeholder: '<ids>', help: 'skip these check ids or id globs (repeatable)' },
  { name: 'ignore', kind: 'array', group: 'Scope', placeholder: '<glob>', help: 'extra ignore pattern for this run (repeatable)' },
  { name: 'ignore-dir', kind: 'array', group: 'Scope', placeholder: '<name|path>', help: 'extra ignored directory for this run (repeatable)' },
  { name: 'gitignore', kind: 'boolean', group: 'Scope', help: '--no-gitignore ignores the .gitignore stack' },
  { name: 'explain-ignores', kind: 'string', group: 'Scope', placeholder: '<path>', help: 'say which rule excluded a path, and exit' },
  { name: 'changed', kind: 'optional-string', group: 'Scope', placeholder: '[ref]', help: 'only files changed against a git ref (default HEAD)' },

  { name: 'estimate', kind: 'boolean', group: 'Run', help: 'forecast files, chunks, tokens and cost; make no API calls' },
  { name: 'max-spend', kind: 'number', group: 'Run', placeholder: '<usd>', help: 'stop before the forecast exceeds this' },
  { name: 'threshold', kind: 'number', group: 'Run', placeholder: '<n>', help: 'override thresholds.report (0-1)' },
  { name: 'concurrency', kind: 'number', group: 'Run', placeholder: '<n>', help: 'parallel requests' },
  { name: 'chunk-tokens', kind: 'number', group: 'Run', placeholder: '<n>', help: 'token budget per chunk' },

  { name: 'out', kind: 'string', group: 'Output', placeholder: '<file>', help: 'Markdown report path' },
  { name: 'verbose', kind: 'boolean', group: 'Output', help: 'show per-file detail and retries' },
  { name: 'quiet', kind: 'boolean', group: 'Output', help: 'errors only' },
  { name: 'color', kind: 'boolean', group: 'Output', help: '--no-color disables colour' },
  { name: 'version', kind: 'boolean', group: 'Output', help: 'print the version' },
  { name: 'help', kind: 'boolean', group: 'Output', help: 'print this help' },
];

const FLAGS_BY_NAME = new Map(FLAGS.map((f) => [f.name, f]));

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string | number | boolean | string[]>;
  errors: string[];
}

/** Exported for tests: the flag grammar is worth pinning down on its own. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string | number | boolean | string[]>();
  const errors: string[] = [];
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (onlyPositionals || arg === '-') {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }
    if (arg === '-h') {
      values.set('help', true);
      continue;
    }
    if (arg === '-v') {
      values.set('verbose', true);
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    const negated = rawName.startsWith('no-') && !FLAGS_BY_NAME.has(rawName);
    const name = negated ? rawName.slice(3) : rawName;
    const spec = FLAGS_BY_NAME.get(name);

    if (!spec) {
      errors.push(`unknown option "${arg}"`);
      continue;
    }

    if (spec.kind === 'boolean') {
      if (inlineValue !== undefined) {
        if (inlineValue === 'true' || inlineValue === 'false') values.set(name, inlineValue === 'true');
        else errors.push(`option "--${name}" takes no value`);
      } else {
        values.set(name, !negated);
      }
      continue;
    }

    if (negated) {
      errors.push(`option "--no-${name}" is not a switch`);
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      const nextIsValue =
        next !== undefined &&
        (next === '-' ||
          !next.startsWith('-') ||
          // Only for a genuinely negative number, never for the next option.
          (spec.kind === 'number' && Number.isFinite(Number(next))));
      if (nextIsValue) {
        value = next;
        i += 1;
      } else if (spec.kind !== 'optional-string') {
        errors.push(`option "--${name}" needs a value`);
        continue;
      }
    }

    if (spec.kind === 'optional-string') {
      values.set(name, value ?? true);
      continue;
    }
    if (spec.kind === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        errors.push(`option "--${name}" needs a number, got "${value}"`);
        continue;
      }
      values.set(name, parsed);
      continue;
    }
    if (spec.kind === 'array') {
      const parts = String(value)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const existing = values.get(name);
      values.set(name, [...(Array.isArray(existing) ? existing : []), ...parts]);
      continue;
    }
    values.set(name, String(value));
  }

  return { positionals, values, errors };
}

export function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function helpText(): string {
  const lines: string[] = [
    'iso-jevdit - ISO/IEC 27001:2022 Annex A audit for your codebase',
    '',
    'Usage',
    '  iso-jevdit [path]                    audit a file or directory (default: .)',
    '  iso-jevdit --provider=openrouter --key=<key>',
    '  iso-jevdit --estimate .              forecast cost without calling the API',
    '',
  ];

  const groups = [...new Set(FLAGS.map((f) => f.group))];
  const width = Math.max(...FLAGS.map((f) => `--${f.name} ${f.placeholder ?? ''}`.trim().length));

  for (const group of groups) {
    lines.push(group);
    for (const flag of FLAGS.filter((f) => f.group === group)) {
      const invocation = `--${flag.name}${flag.placeholder ? ` ${flag.placeholder}` : ''}`;
      lines.push(`  ${invocation.padEnd(width + 2)}${flag.help}`);
    }
    lines.push('');
  }

  lines.push(
    'Exit codes',
    '  0 clean   1 findings at or above --fail-on   2 config error',
    '  3 credential or provider failure   4 no auditable files   5 spend guard   70 internal error',
    '',
    'Keys are stored in ~/.isojevdit/credentials.json and never in settings.json.',
  );
  return lines.join('\n');
}

export async function main(argv: readonly string[]): Promise<ExitCode> {
  const { positionals, values, errors } = parseArgs(argv);

  configureLogger({
    level: values.get('quiet') === true ? 'quiet' : values.get('verbose') === true ? 'verbose' : 'normal',
    ...(values.get('color') === false ? { color: false } : {}),
  });

  if (values.get('help') === true) {
    out(helpText());
    return EXIT.ok;
  }
  if (values.get('version') === true) {
    out(packageVersion());
    return EXIT.ok;
  }
  if (errors.length > 0) {
    throw configError(errors.join('\n  '), ['Run iso-jevdit --help for the full list.']);
  }
  if (positionals.length > 1) {
    throw configError(`expected at most one path, got ${positionals.length}`, [`Paths: ${positionals.join(', ')}`]);
  }

  const target = positionals[0];
  const overrides: Record<string, unknown> = {};
  const providerFlag = values.get('provider');
  if (typeof providerFlag === 'string') overrides.provider = providerFlag;
  if (typeof values.get('concurrency') === 'number') overrides.concurrency = values.get('concurrency');
  if (typeof values.get('max-spend') === 'number') overrides.maxSpendUsd = values.get('max-spend');
  if (typeof values.get('threshold') === 'number') overrides.thresholds = { report: values.get('threshold') };
  if (typeof values.get('chunk-tokens') === 'number') overrides.chunk = { maxTokens: values.get('chunk-tokens') };
  if (typeof values.get('out') === 'string') overrides.report = { out: values.get('out') };
  if (values.get('gitignore') === false) overrides.respectGitignore = false;
  if (Array.isArray(values.get('ignore'))) overrides.ignore = values.get('ignore');
  if (Array.isArray(values.get('ignore-dir'))) overrides.ignoreDirs = values.get('ignore-dir');
  if (Array.isArray(values.get('checks'))) overrides.checks = { include: values.get('checks') };
  if (Array.isArray(values.get('exclude-checks'))) {
    overrides.checks = { ...(overrides.checks as object), exclude: values.get('exclude-checks') };
  }

  const loaded = await loadConfig({
    cwd: process.cwd(),
    ...(target ? { target } : {}),
    ...(typeof values.get('config') === 'string' ? { configFile: values.get('config') as string } : {}),
    overrides,
  });

  const modelFlag = values.get('model');
  if (typeof modelFlag === 'string') {
    const active = loaded.settings.provider;
    loaded.settings.providers[active] = { ...(loaded.settings.providers[active] ?? { headers: {} }), model: modelFlag };
  }

  for (const warning of loaded.warnings) log.warn(warning);

  // --init only needs the root, and runs before check resolution so a broken catalog cannot block it.
  if (values.get('init') === true) {
    return runInit({ root: loaded.root });
  }

  if (values.get('clear-credentials') === true) {
    return runClearCredentials();
  }

  const clearKeyFlag = values.get('clear-key');
  if (clearKeyFlag !== undefined) {
    return runClearKey(loaded.settings, typeof clearKeyFlag === 'string' ? clearKeyFlag : undefined);
  }

  const keyFlag = values.get('key');
  if (typeof keyFlag === 'string') {
    const fromStdin = keyFlag === '-';
    const key = fromStdin ? await readKeyFromStdin() : keyFlag;
    const save = values.get('save') !== false;
    if (save) {
      const code = await runSaveKey({
        settings: loaded.settings,
        ...(typeof providerFlag === 'string' ? { provider: providerFlag } : {}),
        key,
        verify: values.get('verify') !== false,
        fromCommandLine: !fromStdin,
      });
      if (code !== EXIT.ok) return code;
    }
    // A key plus an explicit path means "save, then audit"; a key alone is just the save. With
    // --no-save nothing was stored, so the invocation can only have meant "audit with this key".
    if (save && target === undefined) return EXIT.ok;
  }

  if (values.get('show-config') === true) {
    return runShowConfig(loaded.settings, loaded.sources, typeof providerFlag === 'string' ? providerFlag : undefined);
  }

  const explainPath = values.get('explain-ignores');
  if (typeof explainPath === 'string') {
    const explanation = await explainIgnore(loaded.root, explainPath, loaded.settings);
    out(`${explanation.relPath}: ${explanation.scanned ? 'scanned' : 'not scanned'} - ${explanation.reason}`);
    return explanation.scanned ? EXIT.ok : EXIT.noFiles;
  }

  const { checks, errors: checkErrors } = resolveChecks(loaded.settings);
  if (checkErrors.length > 0) {
    throw configError(`invalid check configuration:\n  - ${checkErrors.join('\n  - ')}`);
  }
  if (checks.length === 0) {
    throw configError('no checks are selected', ['Widen checks.include, or drop --checks / --exclude-checks.']);
  }

  if (values.get('list-checks') === true) {
    return runListChecks(checks);
  }

  const provider = resolveProviderConfig(loaded.settings, typeof providerFlag === 'string' ? providerFlag : undefined);
  const changedFlag = values.get('changed');

  return runAudit({
    loaded,
    checks,
    provider,
    estimateOnly: values.get('estimate') === true,
    version: packageVersion(),
    ...(typeof keyFlag === 'string' && keyFlag !== '-' ? { key: keyFlag } : {}),
    ...(changedFlag !== undefined ? { changedRef: typeof changedFlag === 'string' ? changedFlag : 'HEAD' } : {}),
  });
}

export async function run(argv: readonly string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof IsoJevditError) {
      log.error(err.message);
      for (const hint of err.hints) log.info(`  ${hint}`);
      return err.exitCode;
    }
    log.error((err as Error).message);
    if ((err as Error).stack) log.detail((err as Error).stack!);
    return 70;
  }
}
