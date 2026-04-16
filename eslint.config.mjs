import { FlatCompat } from '@eslint/eslintrc';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  {
    ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'learn/**'],
  },
  ...nextVitals,
  ...nextTs,
  eslintPluginUnicorn.configs['flat/recommended'],
  ...compat.extends(
    'plugin:import/typescript',
    'plugin:security/recommended-legacy',
    'plugin:no-unsanitized/recommended-legacy',
    'plugin:import/recommended',
    'prettier'
  ),
  {
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
        node: true,
      },
    },
    rules: {
      'no-console': 'off',
      /* TODO: should remove it and fix the issues */
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/exhaustive-deps': 'off',

      'suggest-canonical-class': 'off',

      'security/detect-object-injection': 'off',

      '@next/next/no-sync-scripts': 'warn',
      '@next/next/no-css-tags': 'warn',
      '@next/next/no-img-element': 'off',

      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      'react-hooks/static-components': 'off',

      'import/no-unresolved': 'off',
      'import/named': 'off',

      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': [
        'warn',
        {
          case: 'kebabCase',
        },
      ],
      'unicorn/prefer-number-properties': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/prefer-classlist-toggle': 'off',
      'unicorn/prefer-at': 'off',
      'unicorn/prefer-array-find': 'off',
      'unicorn/no-useless-fallback-in-spread': 'off',
      'unicorn/no-negated-condition': 'off',
      'unicorn/error-message': 'off',
      'unicorn/catch-error-name': 'off',
      'unicorn/no-await-expression-member': 'off',
      'unicorn/no-array-for-each': 'off',
      'unicorn/prefer-string-replace-all': 'off',
      'unicorn/explicit-length-check': 'off',
      'unicorn/switch-case-braces': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/no-useless-undefined': 'off',
      'unicorn/prefer-string-raw': 'off',
      'unicorn/prefer-global-this': 'off',
      'unicorn/no-document-cookie': 'off',
      'unicorn/prefer-query-selector': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/prefer-spread': 'off',
    },
  },
];

export default eslintConfig;
