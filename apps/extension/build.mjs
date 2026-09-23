import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

// Clean dist directory
try {
  rmSync(join(process.cwd(), 'dist'), { recursive: true, force: true });
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

const commonOptions = {
  bundle: true,
  minify: false,
  sourcemap: true, // helpful for debugging
};

// Build Content Script (IIFE format)
await esbuild.build({
  ...commonOptions,
  entryPoints: ['src/content/chatgpt-content.ts'],
  outfile: 'dist/content/chatgpt-content.js',
  format: 'iife',
});

// Build Service Worker (ESM format)
await esbuild.build({
  ...commonOptions,
  entryPoints: ['src/background/service-worker.ts'],
  outfile: 'dist/background/service-worker.js',
  format: 'esm',
});

console.log('Build completed successfully.');
