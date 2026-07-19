import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import pkg from './package.json';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Inject version at build time — single source of truth from package.json
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: 'src',
  base: './',
  build: {
    // Webview only runs in VS Code's current-Electron Chromium; a modern target
    // keeps esbuild from down-leveling natively-supported syntax (e.g. destructuring).
    target: 'es2022',
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/index.html'),
      output: {
        // Disable hashing in filenames for webview compatibility
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
        // Code splitting for better performance
        manualChunks: {
          'flow-vendor': ['@xyflow/react'],
          'monaco-vendor': ['monaco-editor/esm/vs/editor/editor.api'],
        },
      },
    },
    // Increase chunk size warning limit (webview bundles are typically larger)
    chunkSizeWarningLimit: 3000,
  },
  resolve: {
    // Prefer TypeScript source when generated JavaScript artifacts are present locally.
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
