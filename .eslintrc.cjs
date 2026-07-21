/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', '*.mjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': ['error', { allow: ['warn', 'error'] }],

    /* src/config/ is the ONLY place process.env may be read. Everything else
     * takes its configuration by injection from the composition root. */
    'no-restricted-syntax': [
      'error',
      {
        selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
        message: 'Read environment variables only in src/config/. Inject config elsewhere.',
      },
      {
        selector: "MemberExpression[object.name='process'][property.name='env']",
        message: 'Read environment variables only in src/config/. Inject config elsewhere.',
      },
    ],
  },
  overrides: [
    {
      files: ['src/config/**/*.ts'],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
  ],
};
