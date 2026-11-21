import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: env.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:4100',
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: '0.0.0.0',
      port: Number(env.PORT || 4174),
      allowedHosts: (env.VITE_ALLOWED_HOSTS || '').split(',').filter(Boolean),
      strictPort: true,
    },
  };
});
