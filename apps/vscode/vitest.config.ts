import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'tests/mocks/vscode.ts'),
    },
  },
});
