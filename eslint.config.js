import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.js',
      '**/dist/**',
      '**/node_modules/**',
      '**/.build/**',
      'apps/recorder-macos/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Async-heavy daemon (SSE server, sqlite ops, job runner): an unawaited
      // or misused promise silently drops work or crashes late.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Interface conformance: many async signatures exist to satisfy shared
      // contracts (Pi tool execute, transport/session factories) even when a
      // given implementation is synchronous. Not enforced.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // TypeBox boundary (contracts §Pi SDK pins): agent-tool parameter schemas
  // must use Pi's pinned standalone `typebox`; wire schemas everywhere else
  // stay on `@sinclair/typebox`. The two module universes are incompatible.
  {
    files: ['packages/**/*.ts', 'apps/daemon/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'typebox',
              message:
                "Wire schemas use '@sinclair/typebox'. Standalone 'typebox' is reserved for Pi agent-tool parameter schemas under apps/daemon/src/agent/tools/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/daemon/src/agent/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@sinclair/typebox',
              message:
                "Tool parameter schemas must use Pi's pinned 'typebox'. Wire schemas belong outside agent/tools.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      // Test fixtures index seeded arrays positionally; assertions there are
      // the local idiom and cannot crash production.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
