/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testMatch: ['**/tests/**/*.test.ts'],
  // Relative ESM imports are written with a .js extension; strip it for resolution.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  clearMocks: true,
  testTimeout: 10000,
  // ── forceExit REMOVED ────────────────────────────────────────────────────
  //
  // It was hiding a warning nobody could act on: "a worker process has failed to
  // exit gracefully", every run. Running with `--detectOpenHandles` across every
  // suite reports nothing, so the residue is the testcontainers/ioredis
  // teardown rather than a leak in this code — and with `forceExit` gone, a
  // future suite that genuinely leaks a timer or a socket will hang and be
  // found, which is the only way anyone ever finds one.
  //
  // If a suite does hang after a change, that is the signal working. Run
  // `npx jest --detectOpenHandles <suite>` rather than putting this back.
};
