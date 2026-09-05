/**
 * Git-diff helpers for the analyze flow (§5.2 steps 4-5, Q7). Runs against
 * the cache clone (a bare repo, both `baseSha` and `headSha` already
 * fetched) — none of this needs a worktree, unlike the parser's own read of
 * actual files.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

/** `git diff --name-status base...head` (§5.2 step 4) → the touched workspace-relative paths. */
export async function diffNameStatus(
  cachePath: string,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--name-status', `${baseSha}...${headSha}`],
    { cwd: cachePath, maxBuffer: MAX_BUFFER },
  );
  return parseNameStatusOutput(stdout);
}

/** Pure parsing, split out from the git call so it's unit-testable on fixture output. */
export function parseNameStatusOutput(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // "M\tpath" for modify/add/delete; "R100\told\tnew" for a rename — the
      // last tab-separated field is always the current (head-side) path.
      const parts = line.split('\t');
      return parts[parts.length - 1] ?? '';
    })
    .filter((path) => path.length > 0);
}

/** `git merge-base --is-ancestor` — the force-push detection §9.1 defers to the worker (no git in the API process). */
export async function isAncestor(
  cachePath: string,
  ancestorSha: string,
  descendantSha: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['merge-base', '--is-ancestor', ancestorSha, descendantSha],
      {
        cwd: cachePath,
      },
    );
    return true;
  } catch {
    // Exit code 1 means "not an ancestor"; a genuinely broken ref also lands
    // here, which is the conservative (fail-the-analysis) direction anyway.
    return false;
  }
}

export interface LineRange {
  start: number;
  end: number;
}

const DEFAULT_CAP_LINES = 200;

/**
 * `git diff -U3 base head -- file` for the whole file, sliced down to just
 * the changed method (Q7). `added`/`removed` pass `null` for the side the
 * method doesn't exist on.
 */
export async function computeSourceDiff(
  cachePath: string,
  baseSha: string,
  headSha: string,
  filePath: string,
  baseRange: LineRange | null,
  headRange: LineRange | null,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--unified=3', baseSha, headSha, '--', filePath],
    { cwd: cachePath, maxBuffer: MAX_BUFFER },
  );
  return extractMethodDiff(stdout, baseRange, headRange);
}

/**
 * Pure string processing over `git diff`'s own hunk-header format
 * (`@@ -oldStart,oldLines +newStart,newLines @@`) — keeps only hunks whose
 * old or new range overlaps the method's line range, then caps the total
 * output. Split out from `computeSourceDiff` so it's testable without git.
 */
export function extractMethodDiff(
  fullDiff: string,
  baseRange: LineRange | null,
  headRange: LineRange | null,
  capLines = DEFAULT_CAP_LINES,
): string {
  if (baseRange === null && headRange === null) return '';

  const lines = fullDiff.split('\n');
  const headerLines: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = [line];
      hunks.push(current);
    } else if (current !== null) {
      current.push(line);
    } else {
      headerLines.push(line);
    }
  }

  const kept = hunks.filter((hunk) => {
    const header = hunk[0];
    return header !== undefined && hunkOverlaps(header, baseRange, headRange);
  });

  const combined = [...headerLines, ...kept.flat()].filter((line) => line.length > 0);
  return combined.slice(0, capLines).join('\n');
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function hunkOverlaps(
  header: string,
  baseRange: LineRange | null,
  headRange: LineRange | null,
): boolean {
  const match = HUNK_HEADER.exec(header);
  if (match === null) return false;

  const oldStart = Number(match[1]);
  const oldLen = match[2] !== undefined ? Number(match[2]) : 1;
  const newStart = Number(match[3]);
  const newLen = match[4] !== undefined ? Number(match[4]) : 1;

  if (baseRange !== null && rangesOverlap(oldStart, oldStart + oldLen - 1, baseRange)) {
    return true;
  }
  if (headRange !== null && rangesOverlap(newStart, newStart + newLen - 1, headRange)) {
    return true;
  }
  return false;
}

function rangesOverlap(aStart: number, aEnd: number, b: LineRange): boolean {
  return aStart <= b.end && b.start <= aEnd;
}
