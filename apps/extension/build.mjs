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
  sourcemap: true,
};

// Build Content Scripts (IIFE format — one per provider)
const contentEntrypoints = [
  { in: 'src/content/chatgpt-content.ts', out: 'dist/content/chatgpt-content.js' },
  { in: 'src/content/claude-content.ts',  out: 'dist/content/claude-content.js'  },
  { in: 'src/content/gemini-content.ts',  out: 'dist/content/gemini-content.js'  },
];

for (const ep of contentEntrypoints) {
  await esbuild.build({
    ...commonOptions,
    entryPoints: [ep.in],
    outfile: ep.out,
    format: 'iife',
  });
}

// Build Service Worker (ESM format)
await esbuild.build({
  ...commonOptions,
  entryPoints: ['src/background/service-worker.ts'],
  outfile: 'dist/background/service-worker.js',
  format: 'esm',
});

console.log('Build completed successfully.');
