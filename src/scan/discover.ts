import fs from 'node:fs/promises';
import path from 'node:path';

import type { Settings } from '../config/schema.js';
import { toPosix } from '../util/fs.js';
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_FILENAMES,
  isEligibleFile,
  languageFor,
} from './extensions.js';
import { createGitignoreFrame, IgnoreEngine, type GitignoreFrame, type IgnoreDecision, type IgnoreLayer } from './ignore.js';

export interface SourceFile {
  absPath: string;
  /** Posix, relative to the scan root. */
  relPath: string;
  language: string;
  sizeBytes: number;
}

export type SkipKind = 'ignored' | 'too-large' | 'not-eligible';

export interface SkipRecord {
  path: string;
  kind: SkipKind;
  isDir: boolean;
  layer?: IgnoreLayer;
  rule?: string;
  detail?: string;
}

export interface DiscoveryCounts {
  eligible: number;
  ignoredDirs: number;
  ignoredFiles: number;
  tooLarge: number;
  notEligible: number;
  /** Skip records dropped after the cap; counts above stay exact. */
  skipRecordsOmitted: number;
}

export interface DiscoveryResult {
  root: string;
  files: SourceFile[];
  skips: SkipRecord[];
  counts: DiscoveryCounts;
  /** True when the target was a single explicit file, which bypasses every filter. */
  explicitFile: boolean;
}

const MAX_SKIP_RECORDS = 2000;

export interface DiscoverOptions {
  root: string;
  targetPath: string;
  targetIsFile: boolean;
  settings: Settings;
  /** From --changed: posix paths relative to the root. */
  limitTo?: ReadonlySet<string>;
}

function effectiveExtensions(settings: Settings): string[] {
  const base = settings.extensions ?? [...DEFAULT_EXTENSIONS];
  return [...new Set([...base, ...settings.extraExtensions].map((e) => (e.startsWith('.') ? e : `.${e}`)))];
}

function effectiveFilenames(settings: Settings): string[] {
  return settings.filenames ?? [...DEFAULT_FILENAMES];
}

async function readGitignore(dir: string, dirRel: string, fileName: string): Promise<GitignoreFrame | undefined> {
  try {
    const content = await fs.readFile(path.join(dir, fileName), 'utf8');
    return createGitignoreFrame(dirRel, dirRel ? `${dirRel}/${fileName}` : fileName, content);
  } catch {
    return undefined;
  }
}

export async function discover(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const { root, settings } = opts;
  const extensions = effectiveExtensions(settings);
  const filenames = effectiveFilenames(settings);
  const engine = new IgnoreEngine(settings);
  const maxBytes = settings.maxFileSizeKb * 1024;

  const files: SourceFile[] = [];
  const skips: SkipRecord[] = [];
  const counts: DiscoveryCounts = {
    eligible: 0,
    ignoredDirs: 0,
    ignoredFiles: 0,
    tooLarge: 0,
    notEligible: 0,
    skipRecordsOmitted: 0,
  };

  const addSkip = (record: SkipRecord): void => {
    if (skips.length < MAX_SKIP_RECORDS) skips.push(record);
    else counts.skipRecordsOmitted += 1;
  };

  // An explicitly named file outranks every filter, including .gitignore and the size cap.
  if (opts.targetIsFile) {
    const stat = await fs.stat(opts.targetPath);
    const relPath = toPosix(path.relative(root, opts.targetPath)) || path.basename(opts.targetPath);
    files.push({
      absPath: opts.targetPath,
      relPath,
      language: languageFor(path.basename(opts.targetPath)),
      sizeBytes: stat.size,
    });
    counts.eligible = 1;
    return { root, files, skips, counts, explicitFile: true };
  }

  const startRel = toPosix(path.relative(root, opts.targetPath));

  const walk = async (dir: string, dirRel: string, frames: readonly GitignoreFrame[]): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      addSkip({ path: dirRel || '.', kind: 'ignored', isDir: true, detail: `unreadable: ${(err as Error).message}` });
      return;
    }

    let nextFrames = frames;
    if (settings.respectGitignore && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      const frame = await readGitignore(dir, dirRel, '.gitignore');
      if (frame) nextFrames = [...frames, frame];
    }

    const dirs: Array<{ abs: string; rel: string; name: string }> = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink() && !settings.followSymlinks) {
        addSkip({ path: rel, kind: 'ignored', isDir: false, detail: 'symbolic link (followSymlinks is false)' });
        continue;
      }

      if (entry.isDirectory()) {
        const decision = engine.decide(rel, true, nextFrames);
        if (decision.ignored) {
          counts.ignoredDirs += 1;
          addSkip({ path: `${rel}/`, kind: 'ignored', isDir: true, ...pick(decision) });
          continue;
        }
        dirs.push({ abs, rel, name: entry.name });
        continue;
      }

      if (!entry.isFile()) continue;

      if (!isEligibleFile(entry.name, { extensions, filenames })) {
        counts.notEligible += 1;
        continue;
      }

      const decision = engine.decide(rel, false, nextFrames);
      if (decision.ignored) {
        counts.ignoredFiles += 1;
        addSkip({ path: rel, kind: 'ignored', isDir: false, ...pick(decision) });
        continue;
      }

      if (opts.limitTo && !opts.limitTo.has(rel)) continue;

      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        continue;
      }
      if (size > maxBytes) {
        counts.tooLarge += 1;
        addSkip({
          path: rel,
          kind: 'too-large',
          isDir: false,
          rule: `maxFileSizeKb: ${settings.maxFileSizeKb}`,
          detail: `${Math.round(size / 1024)} KB`,
        });
        continue;
      }

      counts.eligible += 1;
      files.push({ absPath: abs, relPath: rel, language: languageFor(entry.name), sizeBytes: size });
    }

    for (const child of dirs) await walk(child.abs, child.rel, nextFrames);
  };

  // Rules from .gitignore files above the scan target still apply to what is inside it, at every
  // level between the root and the target. The target's own .gitignore is loaded by walk().
  const ancestorFrames: GitignoreFrame[] = [];
  if (settings.respectGitignore && startRel) {
    const segments = startRel.split('/');
    for (let depth = 0; depth < segments.length; depth += 1) {
      const dirRel = segments.slice(0, depth).join('/');
      const frame = await readGitignore(path.join(root, dirRel), dirRel, '.gitignore');
      if (frame) ancestorFrames.push(frame);
    }
  }

  await walk(opts.targetPath, startRel, ancestorFrames);

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  skips.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, skips, counts, explicitFile: false };
}

function pick(decision: IgnoreDecision): { layer?: IgnoreLayer; rule?: string } {
  return {
    ...(decision.layer ? { layer: decision.layer } : {}),
    ...(decision.rule ? { rule: decision.rule } : {}),
  };
}

export interface IgnoreExplanation {
  relPath: string;
  scanned: boolean;
  reason: string;
}

/** Answers "why was this file not scanned?" by replaying the walk along its ancestors. */
export async function explainIgnore(root: string, target: string, settings: Settings): Promise<IgnoreExplanation> {
  const absolute = path.resolve(root, target);
  const relPath = toPosix(path.relative(root, absolute));
  if (!relPath || relPath.startsWith('..')) {
    return { relPath: relPath || '.', scanned: false, reason: `outside the scan root ${root}` };
  }

  const engine = new IgnoreEngine(settings);
  const segments = relPath.split('/');
  const frames: GitignoreFrame[] = [];

  if (settings.respectGitignore) {
    const rootFrame = await readGitignore(root, '', '.gitignore');
    if (rootFrame) frames.push(rootFrame);
  }

  for (let i = 0; i < segments.length; i += 1) {
    const name = segments[i]!;
    const rel = segments.slice(0, i + 1).join('/');
    const isLast = i === segments.length - 1;
    const abs = path.join(root, rel);

    let isDir = false;
    try {
      isDir = (await fs.stat(abs)).isDirectory();
    } catch {
      return { relPath, scanned: false, reason: 'the path does not exist' };
    }

    if (isDir && settings.respectGitignore) {
      const frame = await readGitignore(abs, rel, '.gitignore');
      if (frame) frames.push(frame);
    }

    const decision = engine.decide(rel, isDir, frames);
    if (decision.ignored) {
      const what = isDir ? `directory ${rel}/` : rel;
      return { relPath, scanned: false, reason: `${what} is excluded by ${decision.layer} rule "${decision.rule}"` };
    }

    if (isLast && !isDir) {
      const extensions = effectiveExtensions(settings);
      const filenames = effectiveFilenames(settings);
      if (!isEligibleFile(name, { extensions, filenames })) {
        return {
          relPath,
          scanned: false,
          reason: 'its extension is not in the audited set (add it with extraExtensions, or name the file directly)',
        };
      }
      const size = (await fs.stat(abs)).size;
      if (size > settings.maxFileSizeKb * 1024) {
        return { relPath, scanned: false, reason: `${Math.round(size / 1024)} KB exceeds maxFileSizeKb (${settings.maxFileSizeKb})` };
      }
    }
  }

  return { relPath, scanned: true, reason: 'no rule excludes it; it is audited' };
}
