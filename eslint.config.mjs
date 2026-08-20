import { FlatCompat } from '@eslint/eslintrc';
import eslintPluginDrizzle from 'eslint-plugin-drizzle';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import { configs as tseslintConfigs } from 'typescript-eslint';

const drizzleObjectName = ['db', 'tx'];

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

// `eslint-config-next` is gone with Next itself. Audited against
// `docs/next-config-eslint.md` and against the 16.3.1 package's own source
// (`dist/index.js`, `dist/typescript.js`): one rule had to be carried over by
// hand, the rest has nothing left to lint.
//
//   * `eslint-config-next/typescript` was `typescript-eslint.configs.recommended`
//     with `no-unused-vars` and `no-unused-expressions` downgraded to warnings.
//     `...tseslintConfigs.recommended` below is that same config: it names 39
//     `@typescript-eslint/*` rules, 19 of them active, the remainder switched
//     off by `prettier` (verified with `eslint --print-config`).
//     `no-unused-expressions` therefore lands on `error` here rather than
//     `warn` — stricter than Next was, deliberately left alone.
//   * Its base config added exactly ONE rule that is not JSX-bound:
//     `import/no-anonymous-default-export`. `plugin:import/recommended` does
//     not include it, so it is re-declared below.
//   * Everything else in that base config — the 21 `@next/next/*` rules, the
//     `eslint-plugin-react` and `eslint-plugin-react-hooks` recommended sets,
//     and the six `jsx-a11y` rules it enabled by hand — needs JSX, an import
//     from `next/*`, or a Pages-Router data-fetching export. There is no
//     `.tsx` file, no `pages/` directory and no `next` import in this
//     repository. `no-assign-module-variable` is the only Next rule that could
//     fire without JSX, and nothing here assigns to `module`. Registering the
//     set anyway would read as coverage while never firing.
//
// IF a front-end is ever added: `eslint-plugin-react`,
// `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y` and
// `@next/eslint-plugin-next` are NOT installed — none of them appears in
// `bun.lock`, and any copy still sitting in `node_modules` is a leftover of an
// install that predates the migration. Add them as devDependencies, scope them
// to the front-end files, and re-read `docs/next-config-eslint.md` for the
// core-web-vitals severity upgrades.
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
    'plugin:import/typescript',
    'plugin:security/recommended-legacy',
    'plugin:no-unsanitized/recommended-legacy',
    'plugin:import/recommended',
    'prettier'
  ),
  {
    languageOptions: {
      // `eslint-config-next` used to declare these. Without them `unicorn`
      // reports `process` as an undeclared variable in every module that reads
      // an env var. Bun implements the Node globals plus its own `Bun`; Next
      // also declared `globals.browser`, which is left out on purpose so a
      // stray `window` or `document` in server code is still an error.
      globals: { ...globals.node, ...globals.builtin, Bun: 'readonly' },
    },
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
      // The one non-JSX rule `eslint-config-next` added on top of the plugin
      // recommended sets. `plugin:import/recommended` does not carry it.
      'import/no-anonymous-default-export': 'warn',

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
    },
  },
  {
    // Bun's built-in modules have no package on disk, so the import resolver
    // cannot find them. They are provided by the runtime, exactly like
    // `node:*` — which the resolver already knows about by name.
    files: ['**/*.{ts,mts,cjs}'],
    rules: {
      'import/no-unresolved': ['error', { ignore: ['^bun:'] }],
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
