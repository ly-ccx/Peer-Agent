import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 端口可通过 PEER_DEV_PORT 覆盖，便于 git worktree 实验室与主实例并存预览。
const devPort = Number(process.env.PEER_DEV_PORT ?? 5173);

export default defineConfig({
  base: './',
  plugins: [
    react(),
    // Let Vite optimize the final CSS against the Electron Chromium target.
    // Tailwind's generic production optimizer otherwise rewrites the standard
    // backdrop-filter declaration into a WebKit-only declaration.
    tailwindcss({ optimize: false }),
  ],
  root: '.',
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
  },
  build: {
    // Desktop CSS only runs in the bundled Electron Chromium. Targeting generic
    // browsers can rewrite standard backdrop-filter into a WebKit-only
    // declaration, which Electron ignores and makes production glass diverge
    // from Vite dev.
    cssTarget: 'chrome146',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
