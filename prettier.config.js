/** @type {import('prettier').Config} */
module.exports = {
  importOrder: [
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
