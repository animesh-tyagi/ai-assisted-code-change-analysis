/**
 * `@impact/worker` CLI — the manual index trigger of BUILD_PLAN Step 3:
 * "Trigger manually (a CLI/script that takes a repo path + SHA) — no webhook
 * yet." Runs the `mode: "full"` index flow (ARCHITECTURE §5.1) against a repo
 * already cloned on disk, at a given commit SHA.
 *
 * ```
 * npm run worker:index -- --repo <path> --sha <sha> [--owner <o>] [--name <n>] [--default-branch <b>] [--include-tests]
 * ```
 *
 * Deliberately hand-rolled argv parsing rather than a CLI library — matches
 * the parser's own Java CLI (`ParseCommand`), whose comment states the same
 * reasoning: "no dependency, and the surface is tiny."
 *
 * Still to come:
 *   - `mode: "subset"` PR-overlay parsing, change detection, traversal → M4
 *   - LLMProvider + validator → M5
 *   - BullMQ, webhook, real GitHub App `repos` → M6
 */

import path from 'node:path';

import { loadConfig } from './config.js';
import { close, connect } from './db/client.js';
import { ensureIndexes } from './db/indexes.js';
import { runIndex } from './indexFlow/runIndex.js';

interface CliArgs {
  repo: string;
  sha: string;
  owner: string;
  name: string;
  defaultBranch: string;
  includeTests: boolean;
}

const FLAG_NAMES = new Set([
  'repo',
  'sha',
  'owner',
  'name',
  'default-branch',
  'include-tests',
]);

function parseArgs(argv: string[]): CliArgs {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) {
      throw new Error(`unexpected argument: ${String(arg)}`);
    }
    const name = arg.slice(2);
    if (!FLAG_NAMES.has(name)) {
      throw new Error(`unknown flag: --${name}`);
    }
    if (name === 'include-tests') {
      options.set(name, 'true');
      continue;
    }
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`missing value for --${name}`);
    }
    options.set(name, value);
  }

  const repo = options.get('repo');
  const sha = options.get('sha');
  if (repo === undefined) throw new Error('--repo is required');
  if (sha === undefined) throw new Error('--sha is required');

  const resolvedRepo = path.resolve(repo);
  return {
    repo: resolvedRepo,
    sha,
    owner: options.get('owner') ?? 'local',
    name: options.get('name') ?? path.basename(resolvedRepo),
    defaultBranch: options.get('default-branch') ?? 'main',
    includeTests: options.has('include-tests'),
  };
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    console.error(
      'usage: --repo <path> --sha <sha> [--owner <o>] [--name <n>] [--default-branch <b>] [--include-tests]',
    );
    return 2;
  }

  const config = loadConfig();
  const db = await connect(config.mongoUrl, config.mongoDb);
  try {
    await ensureIndexes(db);

    const result = await runIndex(db, config, {
      repoPath: args.repo,
      sha: args.sha,
      owner: args.owner,
      name: args.name,
      defaultBranch: args.defaultBranch,
      includeTestSources: args.includeTests,
    });

    console.log(`repoId            : ${result.repoId}`);
    console.log(`graphVersionId    : ${String(result.graphVersionId)}`);
    if (result.stats) {
      console.log(`functions         : ${String(result.stats.functions)}`);
      console.log(`surfaces          : ${String(result.stats.surfaces)}`);
      console.log(`edges             : ${String(result.stats.edges)}`);
      console.log(
        `nonExternalUnresolvedRate : ${(result.stats.nonExternalUnresolvedRate * 100).toFixed(2)}%`,
      );
      console.log(`parseErrors       : ${String(result.stats.parseErrors)}`);
    }
    if (!result.ok) {
      console.error(`index failed: ${String(result.error)}`);
      return 1;
    }
    console.log('index ready; repos.currentGraphVersionId swapped');
    return 0;
  } finally {
    await close();
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith('index.ts')) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('[worker] fatal:', err);
      process.exitCode = 1;
    });
}
