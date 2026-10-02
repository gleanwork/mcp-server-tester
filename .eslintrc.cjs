module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json', './snippets/tsconfig.json'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/consistent-type-imports': [
      'error',
      {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      },
    ],
    '@typescript-eslint/no-misused-promises': [
      'error',
      {
        checksVoidReturn: false,
      },
    ],
  },
  ignorePatterns: [
    'dist',
    'node_modules',
    'examples',
    'scripts',
    'src/cli',
    'src/reporters/ui-src',
    '*.cjs',
    '*.js',
    'playwright.config.ts',
    'tsup.config.ts',
    'vitest.config.mts',
  ],
  overrides: [
    {
      // Relax certain rules for test files
      files: ['**/*.test.ts', '**/*.spec.ts'],
      rules: {
        // Mock objects accessed in tests don't have proper this bindings
        '@typescript-eslint/unbound-method': 'off',
        // Test mocks often use any types
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        // Unused type imports are ok in tests (for type-only assertions)
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            // Allow unused imports in test files
            ignoreRestSiblings: true,
          },
        ],
      },
    },
  ],
};
