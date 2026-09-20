import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, parseSettingsLayer, type Settings } from '../../src/config/schema.js';
import { chunkFiles, findBoundaries } from '../../src/scan/chunk.js';
import { discover, explainIgnore } from '../../src/scan/discover.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/php-shop', import.meta.url));

function settingsWith(partial: Record<string, unknown>): Settings {
  const { settings, errors } = parseSettingsLayer(partial, 'test');
  expect(errors).toEqual([]);
  return settings;
}

async function scan(settings: Settings, target = FIXTURE) {
  return discover({ root: FIXTURE, targetPath: target, targetIsFile: false, settings });
}

describe('discovery on the php-shop fixture', () => {
  it('audits exactly the eligible files', async () => {
    const result = await scan(DEFAULT_SETTINGS);
    expect(result.files.map((f) => f.relPath)).toEqual([
      '.env.example',
      '.github/workflows/ci.yml',
      'config/database.php',
      'src/Auth.php',
      'src/Orders.php',
      'src/Safe.php',
    ]);
  });

  it('audits a file named exactly like a compound extension', async () => {
    // .env.example is a filename, not just a suffix, and a committed one often holds a real secret.
    const result = await scan(DEFAULT_SETTINGS);
    const envFile = result.files.find((f) => f.relPath === '.env.example');
    expect(envFile?.language).toBe('dotenv');
  });

  it('records why each excluded path was excluded', async () => {
    const result = await scan(DEFAULT_SETTINGS);
    const byPath = new Map(result.skips.map((s) => [s.path, s]));

    expect(byPath.get('.vscode/')?.layer).toBe('dot-directory');
    expect(byPath.get('.config/')?.layer).toBe('dot-directory');
    expect(byPath.get('storage/')?.layer).toBe('gitignore');
    expect(byPath.get('storage/')?.rule).toContain('storage/');
    expect(byPath.get('vendor/')?.layer).toBe('defaults');
  });

  it('keeps .github because it is on the dot-directory allow-list', async () => {
    const result = await scan(DEFAULT_SETTINGS);
    expect(result.files.some((f) => f.relPath.startsWith('.github/'))).toBe(true);
  });

  it('honours ignoreDirs by bare name and by root-relative path', async () => {
    const byName = await scan(settingsWith({ ignoreDirs: ['src'] }));
    expect(byName.files.some((f) => f.relPath.startsWith('src/'))).toBe(false);

    const byPath = await scan(settingsWith({ ignoreDirs: ['config'] }));
    expect(byPath.files.some((f) => f.relPath.startsWith('config/'))).toBe(false);
    expect(byPath.files.some((f) => f.relPath.startsWith('src/'))).toBe(true);
  });

  it('honours ignore globs', async () => {
    const result = await scan(settingsWith({ ignore: ['**/Orders.php'] }));
    expect(result.files.map((f) => f.relPath)).not.toContain('src/Orders.php');
  });

  it('lets unignore override .gitignore, the defaults and the dot-directory rule', async () => {
    const result = await scan(settingsWith({ unignore: ['storage/**', 'vendor/**', '.vscode/**'] }));
    const paths = result.files.map((f) => f.relPath);
    expect(paths).toContain('storage/cache.php');
    expect(paths).toContain('vendor/lib/Thing.php');
    expect(paths).toContain('.vscode/settings.json');
  });

  it('scans a dot-directory once it is on includeDotDirs', async () => {
    const result = await scan(settingsWith({ includeDotDirs: ['.config'] }));
    expect(result.files.map((f) => f.relPath)).toContain('.config/tool.yml');
  });

  it('brings gitignored files back when respectGitignore is off', async () => {
    const result = await scan(settingsWith({ respectGitignore: false }));
    expect(result.files.map((f) => f.relPath)).toContain('storage/cache.php');
  });

  it('audits an explicitly named file even when it is ignored', async () => {
    const target = path.join(FIXTURE, 'storage', 'cache.php');
    const result = await discover({ root: FIXTURE, targetPath: target, targetIsFile: true, settings: DEFAULT_SETTINGS });
    expect(result.explicitFile).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.relPath).toBe('storage/cache.php');
  });
});

describe('explainIgnore', () => {
  it('names the rule and the layer that excluded a path', async () => {
    const gitignored = await explainIgnore(FIXTURE, 'storage/cache.php', DEFAULT_SETTINGS);
    expect(gitignored.scanned).toBe(false);
    expect(gitignored.reason).toContain('gitignore');

    const dotDir = await explainIgnore(FIXTURE, '.vscode/settings.json', DEFAULT_SETTINGS);
    expect(dotDir.reason).toContain('dot-directory');
  });

  it('confirms a file that is audited', async () => {
    const explanation = await explainIgnore(FIXTURE, 'src/Auth.php', DEFAULT_SETTINGS);
    expect(explanation.scanned).toBe(true);
  });

  it('explains an extension that is not audited', async () => {
    const explanation = await explainIgnore(FIXTURE, '.gitignore', DEFAULT_SETTINGS);
    expect(explanation.reason).toContain('extension is not in the audited set');
  });
});

describe('chunking', () => {
  it('packs small files from the same directory into one state', async () => {
    const settings = settingsWith({ chunk: { pack: true } });
    const discovery = await scan(settings);
    const { chunks } = await chunkFiles(discovery.files, { settings });

    const packed = chunks.find((c) => c.packed);
    expect(packed?.files.map((f) => f.path).sort()).toEqual(['src/Auth.php', 'src/Orders.php', 'src/Safe.php']);
    expect(chunks.every((c) => new Set(c.files.map((f) => path.posix.dirname(f.path))).size === 1)).toBe(true);
  });

  it('keeps every file in its own chunk when packing is off', async () => {
    const discovery = await scan(DEFAULT_SETTINGS);
    const settings = settingsWith({ chunk: { pack: false } });
    const { chunks } = await chunkFiles(discovery.files, { settings });
    expect(chunks).toHaveLength(discovery.files.length);
    expect(chunks.every((c) => !c.packed)).toBe(true);
  });

  it('never mixes languages in one chunk', async () => {
    const discovery = await scan(settingsWith({ chunk: { packSameDirOnly: false } }));
    const { chunks } = await chunkFiles(discovery.files, { settings: settingsWith({ chunk: { packSameDirOnly: false } }) });
    for (const chunk of chunks) {
      const languages = new Set(chunk.files.map((f) => (f.path.endsWith('.php') ? 'php' : 'other')));
      expect(languages.size).toBe(1);
    }
  });
});

describe('chunk splitting', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'isojevdit-chunk-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('splits a file that exceeds the budget and overlaps the pieces', async () => {
    const body = Array.from({ length: 60 }, (_, i) => `function handler${i}(req) {\n  return ${i};\n}\n`).join('\n');
    const file = path.join(tmp, 'big.js');
    await fs.writeFile(file, body);

    const settings = settingsWith({ chunk: { maxTokens: 500, overlapLines: 5 } });
    const { chunks } = await chunkFiles(
      [{ absPath: file, relPath: 'big.js', language: 'javascript', sizeBytes: body.length }],
      { settings },
    );

    expect(chunks.length).toBeGreaterThan(1);
    const sorted = [...chunks].sort((a, b) => a.files[0]!.startLine - b.files[0]!.startLine);
    for (let i = 1; i < sorted.length; i += 1) {
      const previousEnd = sorted[i - 1]!.files[0]!.endLine;
      const currentStart = sorted[i]!.files[0]!.startLine;
      expect(currentStart).toBeLessThanOrEqual(previousEnd + 1);
    }
    const covered = sorted.at(-1)!.files[0]!.endLine;
    expect(covered).toBe(body.split('\n').length);
  });

  it('keeps the chunk count sane when overlapLines approaches the span', async () => {
    // A large overlap must not collapse forward progress to one line per chunk: each chunk is a
    // paid request, so that turns a legal config into a runaway bill.
    const body = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const file = path.join(tmp, 'wide.js');
    await fs.writeFile(file, body);
    const refs = [{ absPath: file, relPath: 'wide.js', language: 'javascript', sizeBytes: body.length }];

    const tight = await chunkFiles(refs, { settings: settingsWith({ chunk: { maxTokens: 500, overlapLines: 20 } }) });
    const wide = await chunkFiles(refs, { settings: settingsWith({ chunk: { maxTokens: 500, overlapLines: 200 } }) });

    expect(wide.chunks.length).toBeLessThanOrEqual(tight.chunks.length * 3);
    expect(wide.chunks.length).toBeLessThan(30);
    // Still covers the whole file, however the pieces are ordered.
    expect(Math.max(...wide.chunks.map((c) => c.files[0]!.endLine))).toBe(400);
  });

  it('skips binary, empty and minified files with a reason', async () => {
    const binary = path.join(tmp, 'blob.js');
    const empty = path.join(tmp, 'empty.js');
    const minified = path.join(tmp, 'app.js');
    await fs.writeFile(binary, Buffer.from([0x41, 0x00, 0x42]));
    await fs.writeFile(empty, '   \n');
    await fs.writeFile(minified, `var a=1;${'x'.repeat(900)}\n`);

    const files = [
      { absPath: binary, relPath: 'blob.js', language: 'javascript', sizeBytes: 3 },
      { absPath: empty, relPath: 'empty.js', language: 'javascript', sizeBytes: 4 },
      { absPath: minified, relPath: 'app.js', language: 'javascript', sizeBytes: 910 },
    ];
    const { chunks, skips } = await chunkFiles(files, { settings: DEFAULT_SETTINGS });

    expect(chunks).toHaveLength(0);
    expect(skips.map((s) => `${s.path}:${s.kind}`).sort()).toEqual(['app.js:minified', 'blob.js:binary', 'empty.js:empty']);
  });

  it('finds boundaries at closed nesting, not inside strings', () => {
    const lines = [
      'function a() {',
      '  const sql = "SELECT } FROM t";',
      '}',
      '',
      'function b() {',
      '  return 1;',
      '}',
    ];
    const boundaries = findBoundaries(lines);
    expect(boundaries.has(4)).toBe(true);
    expect(boundaries.has(1)).toBe(false);
    expect(boundaries.has(5)).toBe(false);
  });
});

describe('gitignore files above the scan target', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'isojevdit-nested-'));
    await fs.mkdir(path.join(tmp, 'packages', 'api', 'src'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.gitignore'), 'root-ignored.php\n');
    await fs.writeFile(path.join(tmp, 'packages', '.gitignore'), 'mid-ignored.php\n');
    await fs.writeFile(path.join(tmp, 'packages', 'api', '.gitignore'), 'leaf-ignored.php\n');
    for (const name of ['root-ignored.php', 'mid-ignored.php', 'leaf-ignored.php', 'kept.php']) {
      await fs.writeFile(path.join(tmp, 'packages', 'api', 'src', name), '<?php $a = 1;\n');
    }
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('applies every level between the root and the target, not just the root', async () => {
    const target = path.join(tmp, 'packages', 'api');
    const result = await discover({ root: tmp, targetPath: target, targetIsFile: false, settings: DEFAULT_SETTINGS });
    const names = result.files.map((f) => path.posix.basename(f.relPath));

    expect(names).toContain('kept.php');
    expect(names).not.toContain('root-ignored.php');
    expect(names).not.toContain('mid-ignored.php');
    expect(names).not.toContain('leaf-ignored.php');
  });
});
