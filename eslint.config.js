import eslintPlugin from '@typescript-eslint/eslint-plugin'
import typescriptParser from '@typescript-eslint/parser'
import prettierConfig from 'eslint-config-prettier'
import prettierPlugin from 'eslint-plugin-prettier'
import simpleImportSort from 'eslint-plugin-simple-import-sort'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'test-results/**',
      'playwright-report/**',
      // Generated from spec/openapi.yaml (server/scripts/generate.mjs); checked for drift instead.
      'server/src/protocol/generated/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: typescriptParser,
    },
    plugins: {
      '@typescript-eslint': eslintPlugin,
      prettier: prettierPlugin,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prettier/prettier': [
        'warn',
        {
          singleQuote: true,
          semi: false,
          trailingComma: 'all',
          arrowParens: 'avoid',
          printWidth: 100,
          endOfLine: 'auto',
        },
      ],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
    settings: {
      ...prettierConfig,
    },
  },
  // Browser and server code are separate packages: neither may import the other.
  // (Relative paths that leave a package are checked by test/boundaries.test.ts and
  // server/test/boundaries.test.ts.)
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)(server|sample-host)(/|$)',
              message: 'Browser code must not import server code.',
            },
            { regex: '^node:', message: 'Browser code must not import Node.js built-ins.' },
          ],
        },
      ],
    },
  },
  {
    files: ['server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!node:|\\.{1,2}/)',
              message:
                'The server library has no dependencies: only node: built-ins and relative imports are allowed. Adapters take the caller\'s client through an interface instead of importing it.',
            },
          ],
        },
      ],
    },
  },
  // The collector uses the server library as a package (its published entry points), like
  // any other consumer would.
  {
    files: ['collector/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./',
              message:
                'Import the server library as @clearideas/consent-analytics-server, not by relative path.',
            },
          ],
        },
      ],
    },
  },
]
