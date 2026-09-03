/**
 * Git worktree management (ARCHITECTURE §5.1 step 2, D1).
 *
 * D1's full workspace layout is `/data/repos/<repoId>.git` (a cache clone, kept
 * fetched) plus `/data/work/<repoId>/<sha>/` (a worktree per SHA). M3's CLI
 * trigger points directly at a repo already fully cloned on disk — there is no
 * GitHub App yet to clone *from* (that arrives with M6's webhook flow) — so
 * this module implements only the second half: adding and removing a worktree
 * from a repo path the caller already has. `repoPath` plays the role D1's cache
 * clone would play once M6 wires the first half in.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function addWorktree(
  repoPath: string,
  sha: string,
  workDir: string,
): Promise<void> {
  await execFileAsync('git', ['worktree', 'add', '--detach', '--force', workDir, sha], {
    cwd: repoPath,
  });
}

/**
 * Removes a worktree and prunes its metadata from the origin repo. Best-effort:
 * called from a `finally`, so a failure here is logged, never thrown — it must
 * not mask the real success/failure of the index run it's cleaning up after.
 */
export async function removeWorktree(repoPath: string, workDir: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', workDir], {
      cwd: repoPath,
    });
  } catch (err) {
    console.error(`[worker] failed to remove worktree ${workDir}:`, err);
  }
  try {
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoPath });
  } catch (err) {
    console.error(`[worker] failed to prune worktrees for ${repoPath}:`, err);
  }
}
