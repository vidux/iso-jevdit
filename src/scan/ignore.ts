import ignoreFactory, { type Ignore } from 'ignore';

import type { Settings } from '../config/schema.js';
import {
  ALWAYS_SKIP_DIRS,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_GLOBS,
  DEFAULT_INCLUDE_DOT_DIRS,
} from './extensions.js';

export type IgnoreLayer = 'always' | 'defaults' | 'dot-directory' | 'gitignore' | 'ignoreDirs' | 'ignore';

export interface IgnoreDecision {
  ignored: boolean;
  layer?: IgnoreLayer;
  /** The specific rule that decided, for the report and --explain-ignores. */
  rule?: string;
}

const NOT_IGNORED: IgnoreDecision = { ignored: false };

export interface GitignoreFrame {
  /** Directory the file lives in, relative to the scan root, posix separators, '' for the root. */
  dirRel: string;
  source: string;
  patterns: string[];
  ig: Ignore;
}

export function createGitignoreFrame(dirRel: string, source: string, content: string): GitignoreFrame {
  const patterns = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return { dirRel, source, patterns, ig: ignoreFactory().add(patterns) };
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function relativeTo(dirRel: string, relPath: string): string | undefined {
  if (!dirRel) return relPath;
  if (relPath === dirRel) return '';
  return relPath.startsWith(`${dirRel}/`) ? relPath.slice(dirRel.length + 1) : undefined;
}

function testIgnore(ig: Ignore, relPath: string, isDir: boolean): { ignored: boolean; unignored: boolean } {
  if (!relPath) return { ignored: false, unignored: false };
  const direct = ig.test(relPath);
  if (!isDir) return direct;
  // A trailing slash is what makes gitignore's directory-only patterns (`dist/`) match.
  const asDir = ig.test(`${relPath}/`);
  return { ignored: direct.ignored || asDir.ignored, unignored: direct.unignored || asDir.unignored };
}

/** First pattern that matches on its own - used only for reporting, so the cost is acceptable. */
function firstMatchingPattern(patterns: readonly string[], relPath: string, isDir: boolean): string | undefined {
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const single = ignoreFactory().add([pattern]);
    if (testIgnore(single, relPath, isDir).ignored) return pattern;
  }
  return undefined;
}

/** The part of a pattern before its first wildcard - what it can possibly live under. */
function staticPrefix(pattern: string): string {
  const cleaned = pattern.replace(/^!+/, '').replace(/^\/+/, '');
  const wildcard = cleaned.search(/[*?[]/);
  const head = wildcard === -1 ? cleaned : cleaned.slice(0, wildcard);
  const lastSlash = head.lastIndexOf('/');
  return lastSlash === -1 ? '' : head.slice(0, lastSlash + 1);
}

/** Path segments a name-based rule applies to: every directory on the way down. */
function directorySegments(relPath: string, isDir: boolean): string[] {
  const segments = relPath.split('/');
  return isDir ? segments : segments.slice(0, -1);
}

export class IgnoreEngine {
  private readonly settings: Settings;
  private readonly defaultDirNames: Set<string>;
  private readonly defaultGlobs: readonly string[];
  private readonly defaultGlobsIg: Ignore;
  private readonly configGlobsIg: Ignore;
  private readonly unignoreIg: Ignore;
  private readonly unignorePrefixes: string[];
  private readonly includeDotDirs: Set<string>;
  private readonly dirNameRules: string[];
  private readonly dirPathRules: string[];

  constructor(settings: Settings) {
    this.settings = settings;
    this.defaultDirNames = new Set((settings.ignoreDefaults ? DEFAULT_IGNORE_DIRS : []).map((d) => d.toLowerCase()));
    this.defaultGlobs = settings.ignoreDefaults ? DEFAULT_IGNORE_GLOBS : [];
    this.defaultGlobsIg = ignoreFactory().add([...this.defaultGlobs]);
    this.configGlobsIg = ignoreFactory().add(settings.ignore);
    this.unignoreIg = ignoreFactory().add(settings.unignore);
    this.unignorePrefixes = settings.unignore.map(staticPrefix);
    this.includeDotDirs = new Set([...DEFAULT_INCLUDE_DOT_DIRS, ...settings.includeDotDirs].map((d) => d.toLowerCase()));

    this.dirNameRules = [];
    this.dirPathRules = [];
    for (const entry of settings.ignoreDirs) {
      const normalized = normalizeRel(entry);
      if (!normalized) continue;
      if (normalized.includes('/')) this.dirPathRules.push(normalized);
      else this.dirNameRules.push(normalized);
    }
  }

  private unignored(relPath: string, isDir: boolean): boolean {
    if (this.settings.unignore.length === 0) return false;
    return testIgnore(this.unignoreIg, relPath, isDir).ignored;
  }

  /**
   * A directory cannot be pruned when an unignore pattern could match something inside it: the walker
   * would never reach the file to un-ignore it. `unignore: ['storage/**']` therefore has to keep the
   * `storage` directory walkable even though .gitignore excludes it.
   */
  private mightContainUnignored(relPath: string): boolean {
    if (this.unignorePrefixes.length === 0) return false;
    const asDir = `${relPath}/`;
    return this.unignorePrefixes.some((prefix) => prefix === '' || prefix.startsWith(asDir) || asDir.startsWith(prefix));
  }

  /**
   * Layers in order, last word wins: always-skip, shipped defaults, dot-directory policy, the
   * .gitignore stack, ignoreDirs, ignore globs, then unignore overriding everything.
   */
  decide(relPathRaw: string, isDir: boolean, frames: readonly GitignoreFrame[]): IgnoreDecision {
    const relPath = normalizeRel(relPathRaw);
    if (!relPath) return NOT_IGNORED;

    // Name-based rules apply to every directory on the path, so a file is judged the same way
    // whether the walker reached it through a pruned parent or not.
    const segments = directorySegments(relPath, isDir);
    const always = segments.find((segment) => ALWAYS_SKIP_DIRS.includes(segment));
    if (always) return { ignored: true, layer: 'always', rule: always };

    const overridden = this.unignored(relPath, isDir) || (isDir && this.mightContainUnignored(relPath));
    const excluded = (layer: IgnoreLayer, rule: string): IgnoreDecision =>
      overridden ? NOT_IGNORED : { ignored: true, layer, rule };

    const defaultDir = segments.find((segment) => this.defaultDirNames.has(segment.toLowerCase()));
    if (defaultDir) return excluded('defaults', defaultDir);

    if (this.settings.ignoreDefaults) {
      const dotDir = segments.find((segment) => segment.startsWith('.') && !this.includeDotDirs.has(segment.toLowerCase()));
      if (dotDir) return excluded('dot-directory', `${dotDir} (add to includeDotDirs to scan it)`);
    }

    if (!isDir && this.defaultGlobs.length > 0 && testIgnore(this.defaultGlobsIg, relPath, false).ignored) {
      return excluded('defaults', firstMatchingPattern(this.defaultGlobs, relPath, false) ?? 'shipped skip-list');
    }

    if (this.settings.respectGitignore) {
      const decision = this.decideByGitignore(relPath, isDir, frames);
      if (decision) return overridden ? NOT_IGNORED : decision;
    }

    const namedDir = segments.find((segment) =>
      this.dirNameRules.some((rule) => segment.toLowerCase() === rule.toLowerCase()),
    );
    if (namedDir) return excluded('ignoreDirs', namedDir);

    for (const rulePath of this.dirPathRules) {
      if (relPath === rulePath || relPath.startsWith(`${rulePath}/`)) {
        return excluded('ignoreDirs', rulePath);
      }
    }

    if (this.settings.ignore.length > 0 && testIgnore(this.configGlobsIg, relPath, isDir).ignored) {
      return excluded('ignore', firstMatchingPattern(this.settings.ignore, relPath, isDir) ?? 'ignore');
    }

    return NOT_IGNORED;
  }

  /** Shallow to deep, so a nested .gitignore (including a negation) overrides a shallower one. */
  private decideByGitignore(relPath: string, isDir: boolean, frames: readonly GitignoreFrame[]): IgnoreDecision | undefined {
    let decision: IgnoreDecision | undefined;
    for (const frame of frames) {
      const scoped = relativeTo(frame.dirRel, relPath);
      if (scoped === undefined || scoped === '') continue;
      const result = testIgnore(frame.ig, scoped, isDir);
      if (result.unignored) decision = undefined;
      else if (result.ignored) {
        decision = {
          ignored: true,
          layer: 'gitignore',
          rule: `${frame.source}: ${firstMatchingPattern(frame.patterns, scoped, isDir) ?? 'matched'}`,
        };
      }
    }
    return decision;
  }
}
