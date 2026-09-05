/**
 * `@impact/worker` CLI — the manual Step 5 runner:
 *
 * ```
 * npm run worker:explain                      # uses the bundled sample context object
 * npm run worker:explain -- --context <path>  # or your own ContextObject JSON
 * ```
 *
 * Connects Mongo (same `dev:infra` as `worker:index`), ensures indexes, and
 * calls `getOrGenerateExplanation` with the real `GeminiProvider` — this is how
 * Step 5's live-API acceptance criteria get demonstrated: run it once to see a
 * real 3-section explanation over the API, run it again with the same file to
 * see a cache hit with zero further API calls.
 *
 * Hand-rolled argv parsing, matching `index.ts`'s own reasoning: no dependency,
 * tiny surface.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ContextObject } from '@impact/shared';

import { loadConfig } from '../config.js';
import { close, connect } from '../db/client.js';
import { ensureIndexes } from '../db/indexes.js';
import { MongoExplanationStore, type ExplanationStore } from './explanationStore.js';
import { GeminiProvider } from './geminiProvider.js';
import { getOrGenerateExplanation } from './generateExplanation.js';
import { PROMPT_VERSION } from './prompt.js';

const DEFAULT_CONTEXT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sample-context.json',
);

interface CliArgs {
  contextPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) {
      throw new Error(`unexpected argument: ${String(arg)}`);
    }
    const name = arg.slice(2);
    if (name !== 'context') {
      throw new Error(`unknown flag: --${name}`);
    }
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`missing value for --${name}`);
    }
    options.set(name, value);
  }

  return {
    contextPath: options.get('context') ?? DEFAULT_CONTEXT_PATH,
  };
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    console.error('usage: [--context <path>]');
    return 2;
  }

  const config = loadConfig();
  const contextObject = JSON.parse(
    await readFile(args.contextPath, 'utf-8'),
  ) as ContextObject;

  const db = await connect(config.mongoUrl, config.mongoDb);
  try {
    await ensureIndexes(db);

    const store: ExplanationStore = new MongoExplanationStore(db);
    const provider = new GeminiProvider({
      apiKey: config.geminiApiKey,
      model: config.llmModel,
    });

    const { doc, fromCache } = await getOrGenerateExplanation(store, provider, {
      contextObject,
      promptVersion: PROMPT_VERSION,
    });

    console.log(`fromCache        : ${String(fromCache)}`);
    console.log(`degraded         : ${String(doc.degraded)}`);
    console.log(
      `validation       : passed=${String(doc.validation.passed)} attempts=${String(doc.validation.attempts)} violations=${String(doc.validation.violations.length)}`,
    );
    console.log(`usage            : inputTokens=${String(doc.usage.inputTokens)} outputTokens=${String(doc.usage.outputTokens)}`);
    console.log('--- whatChanged ---');
    console.log(doc.sections.whatChanged);
    console.log('--- whoIsAffected ---');
    console.log(doc.sections.whoIsAffected);
    console.log('--- whatToCheck ---');
    console.log(doc.sections.whatToCheck);

    return 0;
  } finally {
    await close();
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith('cli.ts')) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('[worker] fatal:', err);
      process.exitCode = 1;
    });
}
