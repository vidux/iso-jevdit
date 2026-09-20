import fs from 'node:fs/promises';
import path from 'node:path';

import type { Settings } from '../config/schema.js';
import { estimateJsonTokens, estimateTokens } from '../util/tokens.js';
import type { SourceFile } from './discover.js';

export interface ChunkFile {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  content: string;
}

export interface Chunk {
  id: string;
  language: string;
  files: ChunkFile[];
  /** Estimated tokens for the `files` part of the state. */
  tokens: number;
  packed: boolean;
}

export type ReadSkipKind = 'binary' | 'minified' | 'unreadable' | 'empty';

export interface ReadSkip {
  path: string;
  kind: ReadSkipKind;
  detail?: string;
}

export interface ChunkResult {
  chunks: Chunk[];
  skips: ReadSkip[];
}

const MIN_CHUNK_LINES = 20;
const MINIFIED_MEAN_LINE_LENGTH = 400;
const BINARY_SNIFF_BYTES = 8192;

const TOP_LEVEL_DECLARATION =
  /^\s*(?:@\w+|#\[|(?:export|public|private|protected|internal|static|final|abstract|async|declare|open|override|suspend)\s+)*(?:function|func|fn|def|sub|class|interface|trait|enum|struct|impl|record|module|namespace|package|type|const|var|let|template|resource|data|service|CREATE|ALTER|INSERT|UPDATE|DELETE|SELECT)\b/;

function meanLineLength(text: string): number {
  const lines = text.split('\n');
  return lines.length === 0 ? 0 : text.length / lines.length;
}

/**
 * Lines a chunk may start at: nesting is closed, and the line either follows a blank line or opens a
 * new top-level declaration. Good enough to keep functions intact without parsing every language.
 */
export function findBoundaries(lines: readonly string[]): Set<number> {
  const boundaries = new Set<number>([0]);
  let depth = 0;
  let inBlockComment = false;
  let inTemplate = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const depthAtLineStart = depth;

    if (!inBlockComment && !inTemplate && depthAtLineStart === 0 && i > 0) {
      const previous = lines[i - 1]!.trim();
      if (previous === '' || TOP_LEVEL_DECLARATION.test(line)) boundaries.add(i);
    }

    let quote: string | undefined;
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c]!;
      const next = line[c + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          c += 1;
        }
        continue;
      }
      if (quote) {
        if (ch === '\\') c += 1;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (inTemplate) {
        if (ch === '\\') c += 1;
        else if (ch === '`') inTemplate = false;
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '#') break;
      if (ch === '-' && next === '-') break;
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        c += 1;
        continue;
      }
      if (ch === '`') {
        inTemplate = true;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    }
  }
  return boundaries;
}

function makeChunkFile(file: SourceFile, lines: readonly string[], startIndex: number, endIndex: number): ChunkFile {
  return {
    path: file.relPath,
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    content: lines.slice(startIndex, endIndex + 1).join('\n'),
  };
}

/** Splits one file that does not fit the budget, carrying `overlapLines` into the next chunk. */
function splitFile(file: SourceFile, content: string, budgetTokens: number, overlapLines: number): Chunk[] {
  const lines = content.split(/\r?\n/);
  const boundaries = findBoundaries(lines);
  const lineTokens = lines.map((line) => estimateTokens(line) + 1);

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < lines.length) {
    let used = 0;
    let end = start;
    while (end < lines.length && used + lineTokens[end]! <= budgetTokens) {
      used += lineTokens[end]!;
      end += 1;
    }
    if (end === start) end = start + 1; // a single line over budget still has to go somewhere

    let cut = end;
    if (end < lines.length) {
      for (let candidate = end; candidate > start + MIN_CHUNK_LINES; candidate -= 1) {
        if (boundaries.has(candidate)) {
          cut = candidate;
          break;
        }
      }
    }

    const chunkFile = makeChunkFile(file, lines, start, cut - 1);
    chunks.push({
      id: `${file.relPath}:${chunkFile.startLine}-${chunkFile.endLine}`,
      language: file.language,
      files: [chunkFile],
      tokens: estimateJsonTokens([chunkFile]),
      packed: false,
    });

    if (cut >= lines.length) break;
    // Overlap may never consume more than half the span. Without this, an overlapLines close to the
    // span advances one line per chunk, and since every chunk is a paid request the bill multiplies.
    const minAdvance = Math.max(1, Math.floor((cut - start) / 2));
    start = Math.max(cut - overlapLines, start + minAdvance);
  }

  return chunks;
}

/**
 * Packs whole small files into shared states. The question block is re-sent with every request and
 * dominates cost, so fewer, fuller requests are cheaper; localization resolves which member file a
 * positive verdict belongs to.
 */
function packWholeFiles(units: Array<{ file: SourceFile; chunkFile: ChunkFile }>, settings: Settings): Chunk[] {
  const budget = settings.chunk.maxTokens;
  const groups = new Map<string, Array<{ file: SourceFile; chunkFile: ChunkFile }>>();

  for (const unit of units) {
    const dir = settings.chunk.packSameDirOnly ? path.posix.dirname(unit.file.relPath) : '';
    const key = `${unit.file.language}|${dir}`;
    const group = groups.get(key);
    if (group) group.push(unit);
    else groups.set(key, [unit]);
  }

  const chunks: Chunk[] = [];
  for (const group of [...groups.values()]) {
    let current: ChunkFile[] = [];
    let currentTokens = 0;
    const language = group[0]!.file.language; // the group key includes it, so every unit shares it

    const flush = (): void => {
      if (current.length === 0) return;
      const first = current[0]!;
      chunks.push({
        id: current.length === 1 ? `${first.path}:${first.startLine}-${first.endLine}` : `${first.path}+${current.length - 1}`,
        language,
        files: current,
        tokens: estimateJsonTokens(current),
        packed: current.length > 1,
      });
      current = [];
      currentTokens = 0;
    };

    for (const unit of group) {
      const tokens = estimateJsonTokens([unit.chunkFile]);
      if (current.length > 0 && currentTokens + tokens > budget) flush();
      current.push(unit.chunkFile);
      currentTokens += tokens;
    }
    flush();
  }

  return chunks;
}

export interface ChunkOptions {
  settings: Settings;
  /** An explicitly named file bypasses the minified guard, as it bypasses the ignore rules. */
  explicitFile?: boolean;
}

export async function chunkFiles(files: readonly SourceFile[], opts: ChunkOptions): Promise<ChunkResult> {
  const { settings } = opts;
  const budget = settings.chunk.maxTokens;
  const skips: ReadSkip[] = [];
  const chunks: Chunk[] = [];
  const wholeFileUnits: Array<{ file: SourceFile; chunkFile: ChunkFile }> = [];

  for (const file of files) {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file.absPath);
    } catch (err) {
      skips.push({ path: file.relPath, kind: 'unreadable', detail: (err as Error).message });
      continue;
    }

    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      skips.push({ path: file.relPath, kind: 'binary' });
      continue;
    }

    const content = buffer.toString('utf8');
    if (content.trim().length === 0) {
      skips.push({ path: file.relPath, kind: 'empty' });
      continue;
    }
    if (!opts.explicitFile && meanLineLength(content) > MINIFIED_MEAN_LINE_LENGTH) {
      skips.push({
        path: file.relPath,
        kind: 'minified',
        detail: `mean line length ${Math.round(meanLineLength(content))} characters`,
      });
      continue;
    }

    const lines = content.split(/\r?\n/);
    const whole = makeChunkFile(file, lines, 0, lines.length - 1);

    if (estimateJsonTokens([whole]) > budget) {
      chunks.push(...splitFile(file, content, budget, settings.chunk.overlapLines));
    } else if (settings.chunk.pack) {
      wholeFileUnits.push({ file, chunkFile: whole });
    } else {
      chunks.push({
        id: `${whole.path}:${whole.startLine}-${whole.endLine}`,
        language: file.language,
        files: [whole],
        tokens: estimateJsonTokens([whole]),
        packed: false,
      });
    }
  }

  if (wholeFileUnits.length > 0) chunks.push(...packWholeFiles(wholeFileUnits, settings));

  // By path then line number: sorting ids as strings would put ":100-183" before ":84-166".
  chunks.sort((a, b) => {
    const left = a.files[0]!;
    const right = b.files[0]!;
    return left.path.localeCompare(right.path) || left.startLine - right.startLine;
  });
  skips.sort((a, b) => a.path.localeCompare(b.path));
  return { chunks, skips };
}
