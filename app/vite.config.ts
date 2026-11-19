import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { fs: { allow: ['..'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'safari16', outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
