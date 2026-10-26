import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Also run during watched main-process rebuilds: compiling TypeScript does not
// validate SQL. A rejected build must not emit a new host bundle.
const startupGuard = () => ({
  name: 'opentake-startup-guard',
  async buildStart(this: { addWatchFile(path: string): void }) {
    this.addWatchFile(resolve(__dirname, 'resources/database-worker.cjs'));
    try {
      const result = await promisify(execFile)(process.execPath, [
        resolve(__dirname, 'node_modules/vitest/vitest.mjs'), 'run',
        'tests/unit/startup-guard.test.ts',
        'tests/unit/migration-lineage.test.ts',
        'tests/unit/tool-governance-startup.test.ts',
      // Slow CI runners (Intel macOS) need well over a minute for these three files.
      ], { cwd: __dirname, timeout: 180000 });
      console.info(result.stdout);
    } catch (error) {
      const failure = error as {stdout?:string;stderr?:string};
      throw new Error(`Startup guard failed. Fix the migration/startup checks before launching.\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`);
    }
  },
});

export default defineConfig({
  main: { plugins: [startupGuard()], build: { externalizeDeps: true, emptyOutDir: process.env.NODE_ENV_ELECTRON_VITE === 'development' ? false : undefined, rollupOptions: { input: {
    index: resolve(__dirname, 'src/main/index.ts'),
    'pdf-worker': resolve(__dirname, 'src/main/pdf-worker.ts'),
    'earlybird-opentake-mcp': resolve(__dirname, 'src/main/opentake-mcp/bridge.ts'),
  } } } },
  preload: { build: { externalizeDeps: true } },
  renderer: {
    server: { host: '127.0.0.1', port: 5187, strictPort: true },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'development-react-refresh-csp',
        apply: 'serve',
        // React Refresh injects an inline preamble in development only.
        transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      },
    ],
    // Keep the chart and app on the same React dispatcher in development.
    // Prebundle the chart up front instead of discovering it during navigation.
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'recharts'] },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: { '@': resolve(__dirname, 'src/renderer/src') },
    },
  },
});
