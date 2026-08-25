/**
 * Import-graph gate for unreachable files and handlers absent from `routes.ts`.
 * Comments are stripped so dead imports cannot create false reachability.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './strip-comments';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'patches',
  'public',
  'scripts',
]);

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, '.json', '.css'];

/** Tests and benchmarks are tool entry points; handlers must flow through `routes.ts`. */
const ENTRY_DIRECTORIES = ['tests/', 'bench/'];
const ENTRY_FILE_PATTERN =
  /^(server|app|routes|middleware|instrumentation|drizzle\.config|eslint\.config|prettier\.config|postcss\.config|tailwind\.config)\.[a-z]+$/;

/** The generated route table. Every handler must be imported by this file. */
const ROUTE_TABLE = 'routes.ts';

/** Keep exceptions explicit so a pattern cannot absorb future orphaned files. */
const KNOWN_UNREACHABLE = new Set<string>();

/** `from '…'`, `import '…'`, `import('…')`, `require('…')`, `export … from '…'`. */
const SPECIFIER_PATTERN = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

const toKey = (absolutePath: string) =>
  path.relative(ROOT, absolutePath).split(path.sep).join('/');

const walk = (directory: string, found: string[] = []) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `directory` is reached by recursive descent from ROOT, never from input
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walk(full, found);
    } else if (entry.isFile()) {
      found.push(toKey(full));
    }
  }
  return found;
};

const hasExtension = (key: string, extensions: string[]) =>
  extensions.some((extension) => key.endsWith(extension));

const isEntry = (key: string) =>
  ENTRY_DIRECTORIES.some((directory) => key.startsWith(directory)) ||
  (!key.includes('/') && ENTRY_FILE_PATTERN.test(path.posix.basename(key))) ||
  key.endsWith('.d.ts');

/** Every path a bundler would try for one specifier, in order. */
const candidatesFor = (base: string) => {
  const paths = [base];

  // `./x.js` may point at `./x.ts` under bundler resolution
  const rewritten = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  if (rewritten !== base) {
    paths.push(
      ...['.ts', '.tsx', '.mts'].map((extension) => rewritten + extension)
    );
  }

  paths.push(
    ...RESOLVE_EXTENSIONS.map((extension) => base + extension),
    ...RESOLVE_EXTENSIONS.map((extension) => `${base}/index${extension}`)
  );

  return paths;
};

const resolveSpecifier = (
  specifier: string,
  fromKey: string,
  files: Set<string>
) => {
  let base: string;
  if (specifier.startsWith('@/')) base = specifier.slice(2);
  else if (specifier.startsWith('.'))
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromKey), specifier)
    );
  else return null; // package or bare module

  return candidatesFor(path.posix.normalize(base)).find((candidate) =>
    files.has(candidate)
  );
};

/**
 * Every in-repo file a source imports. Extracted from the scan loop so its
 * `continue` is not inside a nested loop — see `enqueueUnreached` below for the
 * same reasoning.
 */
const resolveImports = (
  source: string,
  fromKey: string,
  files: Set<string>
): string[] => {
  const resolved: string[] = [];
  for (const [, specifier] of source.matchAll(SPECIFIER_PATTERN)) {
    if (!specifier) continue;
    const target = resolveSpecifier(specifier, fromKey, files);
    if (target && target !== fromKey) resolved.push(target);
  }
  return resolved;
};

const allFiles = new Set(walk(ROOT));
const codeFiles = [...allFiles].filter(
  (key) => hasExtension(key, CODE_EXTENSIONS) && !key.endsWith('.d.ts')
);

const importsOf = new Map<string, string[]>();
const importersOf = new Map<string, string[]>();

for (const key of codeFiles) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `key` is a repo-relative path produced by the walk above
  const source = stripComments(readFileSync(path.join(ROOT, key), 'utf8'));
  const targets = new Set(resolveImports(source, key, allFiles));

  importsOf.set(key, [...targets]);
  for (const target of targets) {
    importersOf.set(target, [...(importersOf.get(target) ?? []), key]);
  }
}

const reachable = new Set<string>();
const queue = codeFiles.filter((key) => isEntry(key));
for (const key of queue) reachable.add(key);

/**
 * Extracted so its `continue` sits in a single loop, not a nested one:
 * `prefer-continue` wants the early continue and `no-break-in-nested-loop` wants
 * it out of the nest, and a function is the shape both rules accept.
 */
const enqueueUnreached = (targets: readonly string[]) => {
  for (const target of targets) {
    if (reachable.has(target)) continue;
    reachable.add(target);
    queue.push(target);
  }
};

while (queue.length > 0) {
  const current = queue.pop() as string;
  enqueueUnreached(importsOf.get(current) ?? []);
}

/**
 * Reachability does not prove registration, so this is checked separately — and
 * an import does not prove it either.
 *
 * Two distinct gaps, and the weaker check only closed the first:
 *
 * 1. A handler module nothing imports. The old scan could not see even this,
 *    because the commented Next route files carried an import edge to every
 *    handler.
 * 2. A handler module that IS imported but whose exported method never appears
 *    in a `ROUTES` entry. That endpoint is unreachable while looking perfectly
 *    healthy to an import-graph check — which is the exact shape of defect this
 *    scanner claims to catch.
 *
 * So the route table is read as a table: every `import * as NS from '…'` is
 * mapped to its module, every `handler: NS.METHOD` reference is collected, and
 * every HTTP method a handler module exports must be accounted for by one.
 *
 * Deliberately static. Importing `routes.ts` would pull in the whole
 * application, its environment validation and Better Auth, none of which CI has
 * configured for a file scan.
 */
const NAMESPACE_IMPORT = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
const HANDLER_REFERENCE = /handler:\s*(\w+)\.(\w+)/g;
const ROUTES_DECLARATION = /export\s+const\s+ROUTES\b[^=]*=\s*\[/;

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
]);
/**
 * Declaration forms, one unambiguous regex each.
 *
 * `async` gets its own pattern rather than an optional group: in
 * `\s+(?:async\s+)?` a run of whitespace can be split two ways, which is the
 * backtracking shape `security/detect-unsafe-regex` flags. Three flat patterns
 * are cheaper than arguing with it and read better anyway.
 */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  /export\s+const\s+(GET|POST|PUT|DELETE)\b/g,
  /export\s+function\s+(GET|POST|PUT|DELETE)\b/g,
  /export\s+async\s+function\s+(GET|POST|PUT|DELETE)\b/g,
];

/** The `{ … }` of an `export { … }` clause; its contents are split by hand. */
const EXPORT_CLAUSE = /export\s*\{([^}]*)\}/g;
const AS_SEPARATOR = /\s+as\s+/;

/**
 * Every form a handler module can export an HTTP method by.
 *
 * `export const` alone was not enough, and the gap failed OPEN rather than
 * closed: a module using `export function POST` or `export { handler as POST }`
 * exported an unroutable endpoint that this check reported as "exports no HTTP
 * method" — or, alongside a routed `export const GET`, did not report at all.
 * Verified against both shapes. Every handler in the tree currently uses
 * `export const`; the rest exist so the next one is covered whichever form it
 * picks.
 *
 * The `export { … }` clause is split rather than pattern-matched in one go. Two
 * reasons: a single regex spanning the braces needs nested quantifiers, which is
 * a ReDoS shape even on trusted input; and the name that matters is the EXPORTED
 * one, so `{ GET as legacyGet }` must NOT count as a `GET` export while
 * `{ handler as GET }` must. Taking the segment after `as` gets both right.
 */
function exportedMethods(source: string): Set<string> {
  const found = new Set<string>();

  for (const pattern of DECLARATION_PATTERNS) {
    const declarations = source.matchAll(pattern);
    for (const [, method] of declarations)
      if (method !== undefined) found.add(method);
  }

  const clauses = source.matchAll(EXPORT_CLAUSE);
  for (const [, clause] of clauses) {
    const specifiers = (clause ?? '').split(',');
    for (const specifier of specifiers) {
      const exported = specifier.trim().split(AS_SEPARATOR).at(-1)?.trim();
      if (exported !== undefined && HTTP_METHODS.has(exported))
        found.add(exported);
    }
  }

  return found;
}

/**
 * The `[ … ]` of `export const ROUTES = [ … ]`, or null if it cannot be found.
 *
 * Scoping matters: `HANDLER_REFERENCE` applied to the whole file proved only that
 * the TEXT `handler: NS.METHOD` appears somewhere in `routes.ts`, not that the
 * entry is in the array the application iterates. Verified — moving a real entry
 * out of `ROUTES` into an unexported, never-iterated const left the route
 * genuinely unregistered and the gate still passed.
 *
 * Bracket-counted rather than matched with a regex, because the array contains
 * nested object and array literals. String and comment contents cannot confuse
 * the count: the caller strips comments first, and no route path in this table
 * contains a bracket. If that ever stops being true this returns a short slice
 * and the check gets LOUDER (unrouted handlers), not quieter.
 */
function routesArraySlice(table: string): string | null {
  const match = ROUTES_DECLARATION.exec(table);
  if (!match) return null;

  let depth = 0;
  for (
    let index = match.index + match[0].length - 1;
    index < table.length;
    index++
  ) {
    const char = table[index];
    if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) return table.slice(match.index, index + 1);
    }
  }
  return null;
}

const registrationProblems = (() => {
  if (!allFiles.has(ROUTE_TABLE))
    return [`${ROUTE_TABLE} is missing — the route table cannot be checked.`];

  const table = stripComments(
    readFileSync(path.join(ROOT, ROUTE_TABLE), 'utf8')
  );

  const namespaceToModule = new Map<string, string>();
  for (const [, alias, specifier] of table.matchAll(NAMESPACE_IMPORT)) {
    if (!alias || !specifier) continue;
    const target = resolveSpecifier(specifier, ROUTE_TABLE, allFiles);
    if (target) namespaceToModule.set(alias, target);
  }

  const problems: string[] = [];

  // Only references INSIDE the `ROUTES` array count as registration. The imports
  // above are still read from the whole file — an import is a file-level
  // statement and cannot be inside the array.
  const routesArray = routesArraySlice(table);
  if (routesArray === null)
    problems.push(
      `${ROUTE_TABLE}: could not locate the ROUTES array, so no handler could be ` +
        'checked for registration. If the table moved or was renamed, update ' +
        'ROUTES_DECLARATION rather than deleting this check.'
    );

  const routed = new Set<string>();
  const references = (routesArray ?? '').matchAll(HANDLER_REFERENCE);
  for (const [, alias, method] of references) {
    const target = alias ? namespaceToModule.get(alias) : undefined;
    if (target && method) routed.add(`${target}#${method}`);
  }
  const handlers = codeFiles.filter(
    (key) => key.startsWith('app/api/') && key.endsWith('/handler.ts')
  );

  for (const key of handlers) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `key` is a repo-relative path produced by the walk above
    const source = stripComments(readFileSync(path.join(ROOT, key), 'utf8'));
    const exported = exportedMethods(source);

    if (exported.size === 0) {
      problems.push(`${key} exports no HTTP method`);
      continue;
    }

    for (const method of exported)
      if (!routed.has(`${key}#${method}`))
        problems.push(
          `${key} exports ${method} but no ${ROUTE_TABLE} entry routes it`
        );
  }

  return problems;
})();

const unused = codeFiles
  .filter((key) => !reachable.has(key) && !KNOWN_UNREACHABLE.has(key))
  .toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));

if (unused.length === 0) {
  console.log(
    'No unreachable files. Every file is reachable from an entry point.'
  );
} else {
  console.log(
    `${unused.length} unreachable file(s) of ${codeFiles.length} scanned:\n`
  );

  const unusedSet = new Set(unused);
  for (const key of unused) {
    const importers = importersOf.get(key) ?? [];
    const deadImporters = importers.filter((importer) =>
      unusedSet.has(importer)
    );

    if (importers.length === 0) console.log(`  ${key}  — imported by nothing`);
    else
      console.log(
        `  ${key}  — imported only by ${deadImporters.length} dead file(s): ${deadImporters.join(', ')}`
      );
  }

  console.log(
    '\nNote: imports built at runtime (template strings, variables) are invisible to this scan — check before deleting.'
  );
}

if (registrationProblems.length > 0) {
  console.log(`
${registrationProblems.length} unregistered handler(s):
`);
  for (const problem of registrationProblems) console.log(`  ${problem}`);
}

// Non-zero on either failure, so this is a gate rather than advice.
process.exitCode = unused.length > 0 || registrationProblems.length > 0 ? 1 : 0;
