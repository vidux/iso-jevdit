import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitInfo {
  commit: string;
  shortCommit: string;
  branch: string;
  dirty: boolean;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, windowsHide: true });
  return stdout.trim();
}

export async function gitInfo(root: string): Promise<GitInfo | null> {
  try {
    const commit = await git(root, ['rev-parse', 'HEAD']);
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = await git(root, ['status', '--porcelain']);
    return { commit, shortCommit: commit.slice(0, 8), branch, dirty: status.length > 0 };
  } catch {
    return null;
  }
}

/** Absolute-ish repo-relative paths changed against `ref`, for --changed. */
export async function changedFiles(root: string, ref: string): Promise<string[] | null> {
  try {
    // --relative makes git report paths against `root` rather than the repository root, which is what
    // discovery compares them to when .isojevdit sits below the repo root.
    const tracked = await git(root, ['diff', '--name-only', '--relative', '--diff-filter=ACMR', ref]);
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard']);
    return [...tracked.split('\n'), ...untracked.split('\n')].map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export async function isIgnoredByGit(root: string, file: string): Promise<boolean> {
  try {
    await run('git', ['check-ignore', '-q', file], { cwd: root, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
