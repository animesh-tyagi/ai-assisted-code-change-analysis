/**
 * The missing first half of D1: a cache clone per repo
 * (`/data/repos/<repoId>.git`), fetched incrementally, that `worktree.ts`'s
 * `addWorktree` then checks out a SHA from. `worktree.ts`'s own doc comment
 * already flagged this as the piece M6's webhook flow would add.
 *
 * The authenticated URL is passed only as an explicit `git fetch`/`clone`
 * argument, never stored as a persisted `origin` remote (a plain `git clone`
 * would write the token-bearing URL into the bare repo's on-disk `config` —
 * a real credential-at-rest concern even for a short-lived token). So the
 * initial creation uses `git init --bare` + `git fetch` rather than
 * `git clone`, and every subsequent call re-fetches with a freshly-minted
 * token rather than reusing whatever URL a stored remote might have.
 */

import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function buildAuthenticatedCloneUrl(
  owner: string,
  name: string,
  token: string,
): string {
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

export async function ensureCacheClone(
  owner: string,
  name: string,
  token: string,
  cachePath: string,
): Promise<void> {
  const url = buildAuthenticatedCloneUrl(owner, name, token);
  try {
    if (!(await pathExists(cachePath))) {
      await execFileAsync('git', ['init', '--bare', cachePath]);
    }
    await execFileAsync('git', ['fetch', url, '+refs/heads/*:refs/heads/*', '--prune'], {
      cwd: cachePath,
    });
  } catch (err) {
    // git occasionally echoes the remote URL back in its own error output —
    // strip the token before it can propagate into a log or a thrown message.
    throw redactToken(err, token);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function redactToken(err: unknown, token: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(message.split(token).join('***'));
}
