/** @type {import('prettier').Config} */
module.exports = {
  importOrder: [
    // `bun` and `bun:*` FIRST, and `<BUILTIN_MODULES>` spelled out right after
    // them. Both halves of that are load-bearing.
    //
    // The plugin builds `<BUILTIN_MODULES>` from `node:module`'s
    // `builtinModules` OF THE RUNTIME EXECUTING PRETTIER, and injects that group
    // at the TOP of this list when it is not mentioned here — first match wins
    // (`lib/src/constants.js`, `lib/src/utils/normalize-plugin-options.js`).
    // Bun's `builtinModules` contains `bun`, `bun:sqlite`, `bun:test`; Node's
    // does not. So the same file formatted under Bun put every `bun:*` import in
    // the builtin group and under Node put it in the third-party block:
    // `prettier --list-different .` reported 36 files under Bun and none under
    // Node, on one unchanged tree. A developer with no Node installed failed
    // `format:check` on files they had never touched.
    //
    // Matching these two patterns before the builtin group means Bun's extra
    // entries are never consulted, so the output is the same under either
    // runtime. Naming `<BUILTIN_MODULES>` is what suppresses the injection that
    // would otherwise sit above them and undo it.
    '^bun$',
    '^bun:',
    '<BUILTIN_MODULES>',
    '^types$',
    '^type$',
    '<TYPES>',
    '',
    '^(drizzle-orm/(.*)$)|^(drizzle-orm$)',
    '',
    '<THIRD_PARTY_MODULES>',
    '^@/lib/(.*)$',
    '',
    '^@/utils/(.*)$',
    '',
    '^@/hooks/(.*)$',
    '^@/components/ui/(.*)$',
    '^@/components/(.*)$',
    '',
    '^[./]',
    '^[../]',
  ],
  importOrderParserPlugins: ['typescript', 'jsx', 'decorators-legacy'],
  plugins: [
    '@ianvs/prettier-plugin-sort-imports',
    // TODO: uncomment after install tailwind
    // 'prettier-plugin-tailwindcss',
  ],

  semi: true,
  singleQuote: true,
  jsxSingleQuote: true,
  trailingComma: 'es5',
  printWidth: 80,
  tabWidth: 2,
  importOrderTypeScriptVersion: '5.0.0',
  // TODO: uncomment after install tailwind
  // tailwindConfig: './tailwind.config.ts',
  proseWrap: 'preserve',
  bracketSameLine: false,
  bracketSpacing: true,
};
