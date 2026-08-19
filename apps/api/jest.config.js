module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // class-transformer/class-validator decorators call into Reflect.getMetadata at
  // class-definition time; only main.ts loads the polyfill for the real app.
  setupFiles: ['reflect-metadata'],
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
  testRegex: 'src/.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // The generated Prisma client uses NodeNext-style relative imports with explicit
  // `.js` extensions that point at sibling `.ts` files; Jest's resolver does not do
  // TypeScript's extension mapping on its own, so strip the extension and let it
  // resolve the `.ts` file normally.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
}
