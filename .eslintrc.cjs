/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, es2022: true },
  ignorePatterns: [
    'dist',
    'build',
    'node_modules',
    'coverage',
    '*.cjs',
    // The Prisma client is generated into the workspace (see the generator
    // block in schema.prisma); it is a build artifact, not source.
    'packages/database/generated',
    'packages/database/prisma/generated',
    'apps/web/playwright-report',
    'apps/web/test-results',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']",
        message: 'Money rounding must go through @rentwell/domain money helpers, never Math.round.',
      },
      {
        selector: "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
        message:
          'Do not parse monetary values as floats. Use parseAmountToCents from @rentwell/domain.',
      },
    ],
  },
  overrides: [
    {
      files: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/test/**',
        '**/tests/**',
        'packages/test-fixtures/**',
      ],
      rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-explicit-any': 'off' },
    },
    {
      files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
      env: { browser: true },
      parserOptions: { ecmaFeatures: { jsx: true } },
      // React is the only framework here whose correctness rules the compiler
      // cannot express. A hook called conditionally type-checks and then fails
      // at runtime with "rendered fewer hooks than expected", so the rule is an
      // error; a missing effect dependency is a stale closure, so it is too.
      plugins: ['react-hooks'],
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'error',
      },
    },
  ],
};
