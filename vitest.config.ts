import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'reference/packages/*/test/**/*.test.ts',
      'conformance/lib/test/**/*.test.ts',
      'scripts/test/**/*.test.ts',
      'site/test/**/*.test.ts',
    ],
  },
});
