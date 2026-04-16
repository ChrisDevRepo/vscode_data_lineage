import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/hooks/**/*.test.tsx', 'test/hooks/**/*.test.ts'],
    define: {
      __APP_VERSION__: JSON.stringify('test'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/hooks/**'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 80,
      },
    },
  },
});
