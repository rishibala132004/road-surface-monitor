import { defineConfig } from 'vite';

// The base path is set by the Pages workflow (VITE_BASE=/<repo>/) so the
// same build works on GitHub Pages and on a plain static host.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          if (id.includes('node_modules/mqtt') || id.includes('node_modules/mqtt-packet'))
            return 'mqtt';
          return undefined;
        },
      },
    },
  },
  server: { port: 5173, open: false },
});
