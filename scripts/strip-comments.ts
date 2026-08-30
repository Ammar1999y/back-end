/**
 * Removes comments from JavaScript/TypeScript source.
 *
 * A character scanner rather than a regex, because the cases that matter are
 * exactly the ones a regex gets wrong: a `//` inside a string literal
 * (`'https://x'`) is not a comment, and a quote inside a comment does not open a
 * string. Template literals are tracked too — a `//` inside one is content.
 *
 * **REGEX literals are tracked as well, and that is not a refinement.** Without
 * it, `/it's/` put the scanner into a fake string state that ran to the next
 * apostrophe, so every `//` in between survived as code. Measured over all 236
 * source files, 11 kept an un-stripped comment line and one produced a real
 * comment-derived import edge — `utils/images/svg-optimizer.ts`'s
 * "use sanitizeSvgServer from './server'" was extracted as a specifier — which
 * is precisely the false reachability `find-unused-files.ts` strips comments to
 * prevent. The other consumer is worse: `tests/unit/harness-layout.test.ts`'s
 * ownership detector, which enforces `assertHarnessDatabase()`, missed a
 * synthetic file whose unguarded `db.execute` sat behind such a regex.
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

/**
 * The tokens after which a `/` starts a REGEX rather than a division.
 *
 * JS cannot be tokenised without this distinction and there is no shortcut: `a
 * / b` divides, `= /b/` matches. The rule used here is the standard
 * approximation — a regex may begin where a VALUE is expected, i.e. at the start
 * of input or after an operator, a punctuator, or a keyword that cannot end an
 * expression.
 *
 * **NEITHER direction is safe, so neither is a licence to guess.** Missing a
 * real regex is the original defect: a quote inside it opens the fake-string
 * state and every `//` up to the next quote survives as code. Inventing one is
 * the mirror image: the literal is consumed to the next `/`, which can be the
 * first `/` of a `//`, deleting real code and swallowing the comment marker.
 *
 * What is left, deliberately: `)` is NOT a value position — `if (x) /re/.test(y)`
 * is a regex and `(a + b) / 2` is a division, and this scanner cannot tell them
 * apart without a parser. It is excluded because the division form is by far the
 * commoner one in this repository, and a TypeScript-oracle sweep over every
 * source file finds no case where the choice matters today.
 */
const VALUE_POSITION_PUNCTUATORS = new Set([
  '=',
  '(',
  ',',
  ':',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '[',
  '<',
  '>',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
]);

/** Keywords that cannot END an expression, so a following `/` opens a regex. */
const VALUE_POSITION_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const IDENTIFIER_CHARACTER = /[$\w]/;

const WHITESPACE = /\s/;

/**
 * The last two significant tokens EMITTED, which is what decides the next `/`.
 *
 * Emitted rather than read back out of the source, and that is the whole
 * mechanism. A backward scan over the raw text walks into comment trivia and
 * reports whatever character happens to sit there: `const re = /* c *\/ /a'b/;`
 * saw `/` — the end of the block comment — concluded "not a regex", and the
 * apostrophe then opened the fake-string state that swallowed the following
 * `//`. Comment bodies never reach this state, so trivia is invisible to it for
 * free, in both comment forms.
 *
 * A token is one punctuator or one whole identifier, so the keyword test is a
 * lookup rather than a second backward scan.
 */
interface TokenState {
  /** The most recent significant token. */
  token: string;
  /** The one before it — only `--`/`++` needs to look this far back. */
  previous: string;
  /** Whether `token` is still being extended by identifier characters. */
  inIdentifier: boolean;
}

function remember(state: TokenState, char: string): void {
  if (WHITESPACE.test(char)) {
    // Whitespace ends a token without becoming one: `return /re/` must still see
    // `return`, and `foo bar` must not read as one identifier.
    state.inIdentifier = false;
    return;
  }
  if (IDENTIFIER_CHARACTER.test(char)) {
    if (state.inIdentifier) {
      state.token += char;
      return;
    }
    state.previous = state.token;
    state.token = char;
    state.inIdentifier = true;
    return;
  }
  state.previous = state.token;
  state.token = char;
  state.inIdentifier = false;
}

/** Is a `/` here the start of a regex literal, given what precedes it? */
function opensRegex(state: TokenState): boolean {
  // Start of input.
  if (state.token === '') return true;
  // `n-- / total` and `i++ / total` divide. `-` and `+` are value positions
  // because of unary minus (`= -/re/.source`), so the doubled form has to be
  // told apart from it — otherwise the division's `/` opened a literal that ran
  // to the `/` of the following `//`.
  if (
    (state.token === '-' || state.token === '+') &&
    state.token === state.previous
  )
    return false;
  if (VALUE_POSITION_PUNCTUATORS.has(state.token)) return true;
  if (!IDENTIFIER_CHARACTER.test(state.token[0] ?? '')) return false;
  return VALUE_POSITION_KEYWORDS.has(state.token);
}

/**
 * Consumes a regex literal starting at its opening `/`, returning the index just
 * past the closing one.
 *
 * `\.` escapes and `[…]` classes are consumed as units, because a `/` inside
 * either does not close the literal — which is the whole reason a naive scan
 * cannot do this. An unterminated literal (or a newline, which no regex literal
 * may contain) stops the consumption, so malformed input degrades to plain text
 * rather than swallowing the rest of the file.
 */
function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '\n') return start + 1;
    if (char === BACKSLASH) {
      index += 2;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') inClass = true;
    else if (char === '/') return index + 1;
    index += 1;
  }
  return start + 1;
}

export function stripComments(source: string): string {
  const out: string[] = [];
  let index = 0;
  let quote: string | null = null;
  const state: TokenState = { token: '', previous: '', inIdentifier: false };

  while (index < source.length) {
    const char = source[index] as string;

    if (quote) {
      out.push(char);
      if (char === BACKSLASH) {
        out.push(source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
        // The whole literal is one value: `'a' / 2` divides.
        remember(state, char);
      }
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

    // Neither comment form touches `state`: a comment is trivia, and the token
    // before it is still what decides the next `/`.
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

    // A regex literal is copied out VERBATIM, after the two comment forms above
    // so `//` and `/*` still win — neither can open a regex.
    if (char === '/' && opensRegex(state)) {
      const stop = skipRegex(source, index);
      out.push(source.slice(index, stop));
      index = stop;
      // The literal is a value, so the next `/` divides.
      remember(state, '/');
      continue;
    }

    out.push(char);
    remember(state, char);
    index += 1;
  }

  return out.join('');
}
