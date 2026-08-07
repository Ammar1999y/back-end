import { FlatCompat } from '@eslint/eslintrc';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'scripts/**',
    ],
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
      react: { version: '19' },
    },
    rules: {
      // 'react-hooks/set-state-in-effect': 'off',
      // 'react-hooks/exhaustive-deps': 'off',

      // 'suggest-canonical-class': 'off',

      // '@next/next/no-sync-scripts': 'warn',
      // '@next/next/no-css-tags': 'warn',
      // '@next/next/no-img-element': 'off',

      // '@typescript-eslint/no-explicit-any': 'warn',
      // '@typescript-eslint/ban-ts-comment': 'off',
      // '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'unicorn/filename-case': [
        'warn',
        {
          case: 'kebabCase',
        },
      ],

      // 'react-hooks/static-components': 'off',
      // 'import/no-unresolved': 'off',
      // 'import/named': 'off',
      // 'unicorn/prevent-abbreviations': 'off',

      '@typescript-eslint/no-explicit-any': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-minimal-ternary': 'off',

      'unicorn/no-top-level-assignment-in-function': 'off',
      'unicorn/no-unreadable-for-of-expression': 'off',
      'unicorn/no-unsafe-buffer-conversion': 'off',
      'security/detect-object-injection': 'off',

      'unicorn/prefer-string-replace-all': 'off',
      'unicorn/no-declarations-before-early-exit': 'off',
      'unicorn/prefer-simple-condition-first': 'off',
      'unicorn/max-nested-calls': 'off',

      '@typescript-eslint/no-require-imports': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/name-replacements': 'off',
      'unicorn/single-line-block-comment-style': 'off',
      'unicorn/catch-error-name': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/prefer-await': 'off',
      'unicorn/no-for-each': 'off',
      'unicorn/no-negated-array-predicate': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
    },
  },
];

export default eslintConfig;
