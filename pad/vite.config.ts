import { defineConfig } from 'vite';

// Production build is served from GitHub Pages at https://babsy99.github.io/bass-cast/.
// Dev server stays at '/'. Override the build base with PAD_BASE if the repo moves.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.PAD_BASE ?? '/bass-cast/') : '/',
  clearScreen: false,
  server: { fs: { allow: ['..'] } },
  build: { target: 'safari15', outDir: 'dist' },
}));
