import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'BACKEND_PROXY_');
  const target = env.BACKEND_PROXY_TARGET || 'http://127.0.0.1:3000';
  const proxy = {
    '/api/market/live': { target, ws: true }, '/api/robot/live': { target, ws: true }, '/api': target,
  };
  return {
    plugins: [
      tanstackRouter({
        routesDirectory: './src/app/routes',
        generatedRouteTree: './src/app/router/routeTree.gen.ts',
      }),
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    build: { license: true },
    server: { proxy },
    preview: { proxy },
  };
});
