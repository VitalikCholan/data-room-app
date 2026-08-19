module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // class-transformer/class-validator decorators call into Reflect.getMetadata at
  // class-definition time; only main.ts loads the polyfill for the real app.
  setupFiles: ['reflect-metadata'],
  transform: { '^.+\\.ts$': ['ts-jest', {}] },
  testRegex: 'src/.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
}
