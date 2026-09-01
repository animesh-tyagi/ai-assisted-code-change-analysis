import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every workspace package's tests, discovered from the root so a single
    // `npm test` covers the monorepo.
    include: ['{shared,api,worker,eval}/src/**/*.test.ts'],
    environment: 'node',
    // Snapshot testing is a hard requirement later: parser output determinism
    // (M2) and the context object (M4) are both asserted by snapshot.
    snapshotFormat: {
      printBasicPrototype: false,
    },
  },
});
