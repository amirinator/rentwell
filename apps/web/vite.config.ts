import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The browser talks to the Vite origin, so the session cookie is
      // first-party in development exactly as it is in a deployment behind one
      // hostname. Without this the cookie would be cross-site and SameSite=lax
      // would drop it.
      '/graphql': { target: 'http://localhost:4000', changeOrigin: false },
      '/healthz': { target: 'http://localhost:4000', changeOrigin: false },
      '/readyz': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    // `e2e/` holds Playwright specs. Vitest's default include pattern matches
    // `*.spec.ts` too, so without this it would collect them and fail on
    // Playwright's own `test` and `expect` imports.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
