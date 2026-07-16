import { defineConfig } from 'vite';

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
  }
});
