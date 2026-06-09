import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 端口可通过 PEER_DEV_PORT 覆盖，便于 git worktree 实验室与主实例并存预览。
const devPort = Number(process.env.PEER_DEV_PORT ?? 5173);

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  root: '.',
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
