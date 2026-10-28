// SPDX-License-Identifier: Apache-2.0
// The conformance suite: `npm run conformance -- <class>`, e.g. `npm run conformance -- package`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['conformance/**/*.test.ts'],
    exclude: ['conformance/lib/**', '**/node_modules/**'],
    testTimeout: 30_000,
    // The course server class acts as one learner (one bearer token) across its files, so they run one at a time.
    fileParallelism: false,
  },
});
