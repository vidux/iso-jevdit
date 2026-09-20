import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changedFiles, gitInfo } from '../../src/util/git.js';

const run = promisify(execFile);
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true });
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'isojevdit-git-'));
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'test@example.test');
  await git(repo, 'config', 'user.name', 'test');
  await fs.mkdir(path.join(repo, 'packages', 'api', 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'packages', 'api', 'src', 'a.php'), '<?php $a = 1;\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'init');
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('changedFiles', () => {
  it('reports paths relative to the scan root, not the repository root', async () => {
    const projectRoot = path.join(repo, 'packages', 'api');
    await fs.writeFile(path.join(projectRoot, 'src', 'a.php'), '<?php $a = 2;\n');
    await fs.writeFile(path.join(projectRoot, 'src', 'b.php'), '<?php $b = 1;\n');

    const changed = await changedFiles(projectRoot, 'HEAD');

    // Discovery yields 'src/a.php' for this root, so a repo-root-relative path would match nothing
    // and the run would silently audit only the untracked file.
    expect(changed).toContain('src/a.php');
    expect(changed).toContain('src/b.php');
    expect(changed?.some((p) => p.startsWith('packages/'))).toBe(false);
  });

  it('reports paths relative to the repository root when that is the scan root', async () => {
    await fs.writeFile(path.join(repo, 'packages', 'api', 'src', 'a.php'), '<?php $a = 3;\n');
    const changed = await changedFiles(repo, 'HEAD');
    expect(changed).toContain('packages/api/src/a.php');
  });

  it('returns null for an invalid ref and outside a repository', async () => {
    expect(await changedFiles(repo, 'no-such-ref')).toBeNull();
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'isojevdit-plain-'));
    expect(await gitInfo(plain)).toBeNull();
    await fs.rm(plain, { recursive: true, force: true });
  });

  it('reads commit, branch and dirty state', async () => {
    const info = await gitInfo(repo);
    expect(info?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(info?.shortCommit).toHaveLength(8);
    expect(info?.dirty).toBe(false);
  });
});
