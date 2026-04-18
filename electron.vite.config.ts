import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          setup: resolve(__dirname, 'src/preload/setup.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          setup: resolve(__dirname, 'src/renderer/setup/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
        },
      },
    },
  },
});
