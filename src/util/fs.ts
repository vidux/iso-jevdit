import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
}

export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Windows can transiently refuse the replace while a scanner holds the target open.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    await new Promise((r) => setTimeout(r, 60));
    try {
      await fs.rename(tmp, file);
    } catch {
      await fs.writeFile(file, data, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
      await fs.rm(tmp, { force: true });
    }
  }
}

export interface PermissionResult {
  restricted: boolean;
  detail: string;
}

/**
 * On POSIX, mode 600 is the whole story. On Windows, fs.chmod only toggles the read-only bit and
 * restricts nobody, so the ACL has to be rewritten explicitly or the "600" would be decorative.
 */
export async function restrictToCurrentUser(file: string): Promise<PermissionResult> {
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* best effort; the ACL step below is what matters on Windows */
  }

  if (process.platform !== 'win32') {
    return { restricted: true, detail: 'mode 600' };
  }

  const user = os.userInfo().username;
  try {
    await run('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true });
    return { restricted: true, detail: `ACL limited to ${user}` };
  } catch (err) {
    return {
      restricted: false,
      detail: `could not restrict the ACL (${(err as Error).message.split('\n')[0]?.trim() ?? 'icacls failed'})`,
    };
  }
}

export async function removeFileIfExists(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
