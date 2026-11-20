import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const saasRoot = fileURLToPath(new URL('../../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      fs: { allow: [resolve(saasRoot)] },
      proxy: {
        '/api': {
          target: env.VITE_BACKEND_ORIGIN || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
