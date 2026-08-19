// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'src/generated/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Destructuring a key off an object purely to omit it (`const { X, ...rest } = obj`)
      // is idiomatic and not an unused-variable bug.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Scoped to test/**/*.ts only — src/** keeps the rule as set above. e2e specs hand
    // `app.getHttpServer()` (typed `any` by supertest/@types/express) into `request()` on
    // every single call; that is the test *fixture*, not the behaviour under test, and
    // typing it precisely would just document supertest's own loose types back to
    // ourselves. This was 19 warnings across 2 files with no exceptions, and plans 02/03
    // add ~15 more specs on the identical pattern — an explicit, narrow off beats everyone
    // learning to scroll past a warning count that only grows.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
