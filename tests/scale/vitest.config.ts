/** Optional scale checks, isolated from default test discovery. */
import { defineConfig } from 'vitest/config';
import base from '../../vitest.config';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/scale/**/*.test.ts'],
    execArgv: ['--stack-size=8000'],
    testTimeout: 300_000,
  },
});
