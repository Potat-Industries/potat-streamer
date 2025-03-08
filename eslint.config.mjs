import typescriptEslint from '@typescript-eslint/eslint-plugin';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';

// @ts-expect-error i dont care
import tsParser from '@typescript-eslint/parser';
// @ts-expect-error i dont care
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  ...compat.extends('plugin:@typescript-eslint/recommended'),
  ...compat.extends('airbnb-base/legacy'),
  {
  plugins: {
    '@typescript-eslint': typescriptEslint,
  },

  languageOptions: {
      globals: {
          ...globals.browser,
          ...Object.fromEntries(Object.entries(globals.commonjs).map(([key]) => [key, 'off'])),
      },

      parser: tsParser,
      ecmaVersion: 2025,
      sourceType: 'module',

      parserOptions: {
          requireConfigFile: false,
          babelOptions: { plugins: ['@typescript-eslint/eslint-plugin'] },
      },
  },

  rules: {
      strict: ['error', 'global'],

      quotes: ['error', 'single', {
          allowTemplateLiterals: true,
          avoidEscape: true,
      }],

      'no-eval': 'off',
      'new-cap': 'off',
      'no-promise-executor-return': 'off',
      'no-plusplus': 'off',

      'no-unused-vars': ['error', {
          argsIgnorePattern: 'client|msg',
      }],

      'no-await-in-loop': 'off',
      'no-restricted-syntax': 'off',
      'no-continue': 'off',
      'global-require': 'off',
      'no-unused-expressions': 'off',
      'one-var': 'off',
      'no-void': 'off',
      'no-param-reassign': 'off',
      'no-global-assign': 'off',
      'no-unsafe-optional-chaining': 'off',
      'consistent-return': 'off',
      'no-new': 'off',
      'no-bitwise': 'off',
      'class-methods-use-this': 'off',
      'no-new-object': 'off',
      'func-names': 'off',
      'no-underscore-dangle': 'off',
      'no-use-before-define': 'off',
      'no-return-assign': 'off',
      'operator-linebreak': 'off',
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      'array-callback-return': 'off',
      'max-classes-per-file': 'off',
      semi: ['error', 'always'],
      'linebreak-style': ['error', 'unix'],
      radix: 'off',

      'comma-dangle': ['error', {
        arrays: 'always-multiline',
        objects: 'always-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'always-multiline',
      }],
  },
}, {
  files: ['tests/**/*', '**/*.d.ts'],
}];
