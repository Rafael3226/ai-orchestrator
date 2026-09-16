import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: '/',
  resolve: {
    // Type-only imports of the server's wire types; erased at build, resolvable in the editor.
    alias: { '@server': fileURLToPath(new URL('../src/server', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:7777', changeOrigin: true } },
  },
});
