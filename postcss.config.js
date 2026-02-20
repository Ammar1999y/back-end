module.exports = {
  plugins: [
    'tailwindcss',
    'postcss-flexbugs-fixes',
    'postcss-dir-tailwind-fix',
    'postcss-inset-shorthand-optimized',
    [
      'postcss-focus-with-ignore',
      {
        ignoreStartWith: ['.scroll', '::-webkit', 'scrollbar'],
      },
    ],
    'autoprefixer',
  ],
};
