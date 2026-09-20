import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/load.js';
import { parseJsonc } from '../../src/config/jsonc.js';
import { crossValidate, mergeRawLayers, parseSettingsLayer } from '../../src/config/schema.js';

let tmp: string;
let home: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'isojevdit-config-'));
  home = path.join(tmp, 'home');
  await fs.mkdir(home, { recursive: true });
  process.env.ISO_JEVDIT_HOME = home;
});

afterEach(async () => {
  delete process.env.ISO_JEVDIT_HOME;
  delete process.env.ISO_JEVDIT_CONCURRENCY;
  delete process.env.ISO_JEVDIT_PROVIDER;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeProjectSettings(root: string, settings: unknown): Promise<void> {
  const dir = path.join(root, '.isojevdit');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
}

describe('settings schema', () => {
  it('fills defaults from an empty object', () => {
    const { settings, errors } = parseSettingsLayer({}, 'test');
    expect(errors).toEqual([]);
    expect(settings.provider).toBe('openrouter');
    expect(settings.chunk.maxTokens).toBe(8000);
    expect(settings.thresholds.report).toBe(0.6);
    expect(settings.respectGitignore).toBe(true);
  });

  it('warns about an unknown key and suggests the nearest valid one', () => {
    const { settings, warnings, errors } = parseSettingsLayer({ ignoreDir: ['.vscode'], maxFileSizeKB: 10 }, 'settings.json');
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toContain('unknown setting "ignoreDir"');
    expect(warnings.join('\n')).toContain('did you mean "ignoreDirs"');
    expect(warnings.join('\n')).toContain('did you mean "maxFileSizeKb"');
    // The rest of the file still applies.
    expect(settings.ignoreDirs).toEqual([]);
  });

  it('treats an out-of-range value as an error, not a warning', () => {
    const { errors } = parseSettingsLayer({ thresholds: { report: 1.5 } }, 'settings.json');
    expect(errors.join('\n')).toContain('thresholds.report');
  });

  it('rejects a high threshold below the reporting threshold', () => {
    const { settings } = parseSettingsLayer({ thresholds: { report: 0.9, high: 0.5 } }, 'test');
    expect(crossValidate(settings).join('\n')).toContain('thresholds.high');
  });
});

describe('layer merging', () => {
  it('appends ignore arrays and replaces others', () => {
    const merged = mergeRawLayers([
      { ignore: ['a'], ignoreDirs: ['.vscode'], extensions: ['.php'], concurrency: 2 },
      { ignore: ['b'], ignoreDirs: ['.idea'], extensions: ['.ts'], concurrency: 8 },
    ]);
    expect(merged.ignore).toEqual(['a', 'b']);
    expect(merged.ignoreDirs).toEqual(['.vscode', '.idea']);
    expect(merged.extensions).toEqual(['.ts']);
    expect(merged.concurrency).toBe(8);
  });

  it('deep-merges nested objects', () => {
    const merged = mergeRawLayers([{ chunk: { maxTokens: 4000, pack: false } }, { chunk: { maxTokens: 9000 } }]);
    expect(merged.chunk).toEqual({ maxTokens: 9000, pack: false });
  });
});

describe('jsonc', () => {
  it('parses comments and trailing commas', () => {
    const parsed = parseJsonc(`{
      // a line comment
      "provider": "openrouter", /* inline */
      "ignore": ["a",],
    }`) as Record<string, unknown>;
    expect(parsed.provider).toBe('openrouter');
    expect(parsed.ignore).toEqual(['a']);
  });

  it('leaves comment-like text inside strings alone', () => {
    const parsed = parseJsonc('{"ignore": ["https://example.test/a", "a//b"]}') as { ignore: string[] };
    expect(parsed.ignore).toEqual(['https://example.test/a', 'a//b']);
  });
});

describe('loadConfig precedence', () => {
  it('applies user settings, then project, then env, then flags', async () => {
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ concurrency: 2, maxFileSizeKb: 100 }));
    await writeProjectSettings(tmp, { concurrency: 3 });
    process.env.ISO_JEVDIT_CONCURRENCY = '5';

    const loaded = await loadConfig({ cwd: tmp, target: '.', overrides: { concurrency: 9 } });
    expect(loaded.settings.concurrency).toBe(9);
    expect(loaded.settings.maxFileSizeKb).toBe(100);

    const withoutFlag = await loadConfig({ cwd: tmp, target: '.' });
    expect(withoutFlag.settings.concurrency).toBe(5);
  });

  it('roots the scan at the directory holding .isojevdit', async () => {
    const nested = path.join(tmp, 'packages', 'api', 'src');
    await fs.mkdir(nested, { recursive: true });
    await writeProjectSettings(tmp, { concurrency: 7 });

    const loaded = await loadConfig({ cwd: tmp, target: nested });
    expect(loaded.root).toBe(tmp);
    expect(loaded.settings.concurrency).toBe(7);
    expect(loaded.projectConfigDir).toBe(path.join(tmp, '.isojevdit'));
  });

  it('does not mistake the user config directory for a project root', async () => {
    // ISO_JEVDIT_HOME is an ancestor of the project here, which is the normal layout once a user has
    // saved a credential. Treating it as a project marker would move the report out of the project
    // and re-base every ignore rule.
    const userDir = path.join(tmp, '.isojevdit');
    await fs.mkdir(userDir, { recursive: true });
    process.env.ISO_JEVDIT_HOME = userDir;
    const project = path.join(tmp, 'proj', 'src');
    await fs.mkdir(project, { recursive: true });

    const loaded = await loadConfig({ cwd: tmp, target: project });
    expect(loaded.projectConfigDir).toBeUndefined();
    expect(loaded.root).toBe(project);
  });

  it('still finds a genuine project marker above the target', async () => {
    const userDir = path.join(tmp, '.isojevdit');
    await fs.mkdir(userDir, { recursive: true });
    process.env.ISO_JEVDIT_HOME = userDir;
    const project = path.join(tmp, 'proj');
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await writeProjectSettings(project, { concurrency: 6 });

    const loaded = await loadConfig({ cwd: tmp, target: path.join(project, 'src') });
    expect(loaded.root).toBe(project);
    expect(loaded.settings.concurrency).toBe(6);
  });

  it('warns when a key is found in settings.json', async () => {
    await writeProjectSettings(tmp, { providers: { openrouter: { apiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz' } } });
    const loaded = await loadConfig({ cwd: tmp, target: '.' });
    expect(loaded.warnings.join('\n')).toContain('providers.openrouter.apiKey is set in settings.json');
  });

  it('fails on a missing target', async () => {
    await expect(loadConfig({ cwd: tmp, target: 'nope' })).rejects.toThrow(/no such file or directory/);
  });
});
