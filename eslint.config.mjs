import { FlatCompat } from '@eslint/eslintrc';
import eslintPluginDrizzle from 'eslint-plugin-drizzle';
import * as eslintPluginImportX from 'eslint-plugin-import-x';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import { configs as tseslintConfigs } from 'typescript-eslint';

const drizzleObjectName = ['db', 'tx'];

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

// This config is server-only, and that has one consequence worth stating: the
// React, React-Hooks, JSX-a11y and `@next/next` rule sets are NOT registered and
// their plugins are NOT installed (nothing in `bun.lock`; any copy in
// `node_modules` is a leftover). Every rule in them needs JSX, a `next/*` import
// or a Pages-Router export, so registering them would read as coverage while
// never firing.
//
// IF a front-end is ever added: install those four as devDependencies, scope
// them to the front-end files, and read `docs/next-config-eslint.md` for the
// core-web-vitals severity upgrades.
//
// `import-x/no-anonymous-default-export` below is re-declared by hand because
// `plugin:import/recommended` does not include it.
const eslintConfig = [
  {
    // `bench/**` is tracked project code but deliberately outside this config: it
    // is a standalone harness with no tsconfig, targeting two runtimes (Node and
    // Bun) with plain `.mjs` and console reporting, so the app's rules do not
    // apply to it. Prettier still formats it, and `format:check` still gates it.
    ignores: ['dist/**', 'out/**', 'build/**', 'bench/**'],
  },
  ...tseslintConfigs.recommended,
  eslintPluginUnicorn.configs.recommended,
  ...compat.extends(
    'plugin:security/recommended-legacy',
    'plugin:no-unsanitized/recommended-legacy',
    'prettier'
  ),
  eslintPluginImportX.flatConfigs.recommended,
  eslintPluginImportX.flatConfigs.typescript,
  {
    languageOptions: {
      // Without these `unicorn` reports `process` as undeclared in every module
      // that reads an env var. `globals.browser` is left out on purpose, so a
      // stray `window` or `document` in server code is still an error.
      globals: { ...globals.node, ...globals.builtin, Bun: 'readonly' },
    },
    settings: {
      'import-x/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
        node: true,
      },
    },
    rules: {
      'import-x/no-anonymous-default-export': 'warn',

      // CommonJS default imports legitimately expose named members.
      // 'import-x/no-named-as-default-member': 'off',

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

      'security/detect-object-injection': 'off',

      'unicorn/max-nested-calls': 'off',

      '@typescript-eslint/no-require-imports': 'off',
      'unicorn/no-null': 'off',
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

      // Schema and action values follow the same verb-based naming as handlers.
      'unicorn/no-non-function-verb-prefix': 'off',
      // Explicit comparisons preserve narrowing for optional permission flags.
      'unicorn/no-unnecessary-boolean-comparison': 'off',
    },
  },
  {
    // Catch ignored or misrouted promises in security and persistence paths.
    files: [
      'app/**/*.ts',
      'lib/**/*.ts',
      'db/**/*.ts',
      'utils/**/*.ts',
      'types/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.ts',
      'routes.ts',
      'app.ts',
      'server.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // Bun's built-in modules have no package on disk, so the import resolver
    // cannot find them. They are provided by the runtime, exactly like
    // `node:*` — which the resolver already knows about by name.
    files: ['**/*.{ts,mts,cjs}'],
    rules: {
      'import-x/no-unresolved': ['error', { ignore: ['^bun:'] }],
    },
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: {
      drizzle: eslintPluginDrizzle,
    },
    rules: {
      'drizzle/enforce-delete-with-where': ['error', { drizzleObjectName }],
      'drizzle/enforce-update-with-where': ['error', { drizzleObjectName }],
    },
  },
  {
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      'prettier/prettier': 'warn',
      // Prettier reformats both of these, so ESLint's opinion on them conflicts.
      'arrow-body-style': 'off',
      'prefer-arrow-callback': 'off',
    },
  },
];

export default eslintConfig;
