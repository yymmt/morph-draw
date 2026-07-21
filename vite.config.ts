import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './', // Use relative path for portability across environments/subdirectories
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 3000,
    open: true
  },
  test: {
    environment: 'jsdom',
    globals: true,
  }
});
