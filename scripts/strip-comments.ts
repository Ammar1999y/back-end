/**
 * Removes comments from JavaScript/TypeScript source.
 *
 * A character scanner rather than a regex, because the two cases that matter are
 * exactly the ones a regex gets wrong: a `//` inside a string literal
 * (`'https://x'`) is not a comment, and a quote inside a comment does not open a
 * string. Template literals are tracked too — a `//` inside one is content.
 *
 * Comment bodies become spaces rather than being deleted, and newlines are kept,
 * so nothing that was on separate lines is joined into a new token and line
 * numbers are preserved for anything that reports them.
 *
 * Its own module because `find-unused-files.ts` needs it and it is the kind of
 * thing a second consumer will want; keeping it inline would guarantee a second
 * copy.
 */

/** One backslash. Named because `'\\'` reads as two at a glance. */
const BACKSLASH = '\\';

/** The three characters that open a string literal in JS/TS. */
const QUOTES = new Set(["'", '"', '`']);

export function stripComments(source: string): string {
  const out: string[] = [];
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index] as string;

    if (quote) {
      out.push(char);
      if (char === BACKSLASH) {
        out.push(source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (QUOTES.has(char)) {
      quote = char;
      out.push(char);
      index += 1;
      continue;
    }

    const next = source[index + 1];

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out.push(' ');
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let i = index; i < stop; i++)
        out.push(source[i] === '\n' ? '\n' : ' ');
      index = stop;
      continue;
    }

    out.push(char);
    index += 1;
  }

  return out.join('');
}
