import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      'test-results/**',
      '.vscode-test/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Prettier owns code layout and never wraps comments, so only comment lines are limited.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'max-len': [
        'error',
        {
          code: Number.MAX_SAFE_INTEGER,
          comments: 100,
          ignoreUrls: true,
          ignorePattern: '^\\s*(//|/\\*)\\s*(eslint|@ts-|prettier-ignore)',
        },
      ],
    },
  },
);
