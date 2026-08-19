module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  setupFiles: ['reflect-metadata'],
  transform: { '^.+\\.ts$': ['ts-jest', {}] },
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 30000,
}
