// ESLint 10 flat config. Type-aware linting across the TypeScript workspaces.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    // Worker workspace scratch space (cache clones, worktrees) — real repo
    // content checked out at runtime, not project source. Found live (M6
    // phase 6 field-testing): a real GitHub repo's own stray .js file under
    // worker/data/work/... got swept into a project-wide lint run.
    '**/data/**',
    // Owned by other toolchains / later milestones.
    'parser/**',
    'web/**',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root config files aren't part of any package tsconfig, but we still
          // want them linted.
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
      },
    },
    rules: {
      // The graph model is deliberately full of string-literal unions and
      // exhaustive narrowing; this rule fires on legitimate transcription work.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // console is the API's and worker's only reporting channel until M6 adds
      // real logging.
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
]);
