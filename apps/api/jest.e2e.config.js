module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // `test:e2e` sets DOTENV_CONFIG_PATH=.env.test, which `dotenv/config` reads on its own
  // (see dotenv/lib/env-options.js) — without it this would load the development .env
  // and every e2e spec would read and write the same database `pnpm dev` uses.
  setupFiles: ['dotenv/config', 'reflect-metadata'],
  // Override the project's `module: nodenext` for the test transform only (the real
  // build still uses tsconfig.build.json via `nest build`). Under nodenext, TS leaves
  // `await import(...)` as a native dynamic import even in CommonJS files, and the
  // generated Prisma client's WASM query-compiler loader uses exactly that — which
  // Jest's CJS runtime rejects without --experimental-vm-modules. Forcing `commonjs`
  // here makes ts-jest downlevel it to `require()` instead.
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: { module: 'commonjs', moduleResolution: 'node', resolvePackageJsonExports: false } },
    ],
  },
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // The generated Prisma client uses NodeNext-style relative imports with explicit
  // `.js` extensions that point at sibling `.ts` files; Jest's resolver does not do
  // TypeScript's extension mapping on its own, so strip the extension and let it
  // resolve the `.ts` file normally.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testTimeout: 30000,
}
