import tsdoc from 'eslint-plugin-tsdoc';
import tseslint from 'typescript-eslint';

// Report-only: tsdoc findings are warnings and `lint` is not a gate step yet.
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
    languageOptions: { parser: tseslint.parser },
    // Loaded without rules so existing `eslint-disable @typescript-eslint/...` comments resolve.
    plugins: { tsdoc, '@typescript-eslint': tseslint.plugin },
    rules: { 'tsdoc/syntax': 'warn' },
  },
);
