/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * ESLint configuration for OpenClaw Feishu Plugin.
 */

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const globals = {
  console: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  Buffer: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  global: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  clearImmediate: 'readonly',
};

const config = [
  {
    ignores: [
      'node_modules/',
      'dist/',
      'coverage/',
      '*.log',
      '.vscode/',
      '.idea/',
      '*.tsbuildinfo',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
      },
      globals,
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Error prevention
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // Type safety - warnings only
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Prefer interface over type
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],

      // Best practices
      'no-var': 'error',
      'prefer-const': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'warn',

      // Internal functions rely on type inference; only exported API
      // surface requires explicit return types.
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'warn',
    },
  },
];

export default config;
