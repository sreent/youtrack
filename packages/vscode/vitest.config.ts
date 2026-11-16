import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// VS Code's API exists only inside VS Code: the tests run against a stand-in (test/vscode.ts).
export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL('./test/vscode.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] },
});
