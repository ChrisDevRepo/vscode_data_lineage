import tsdoc from 'eslint-plugin-tsdoc';
import tseslint from 'typescript-eslint';

// Gate-enforced: tsdoc findings are errors; the gate's `lint` and `knip` steps fail on any finding.
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
    rules: { 'tsdoc/syntax': 'error' },
  },
);
