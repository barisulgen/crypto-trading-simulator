import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: SERVER },
      '/ws': { target: SERVER, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
