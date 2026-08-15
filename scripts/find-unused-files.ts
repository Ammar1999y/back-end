/**
 * Reports code files that the app can never reach.
 *
 * Roots are the files a framework or tool loads directly (everything under
 * `app/`, `middleware.*`, `*.config.*`, ...). Every other file is reachable
 * only if some reachable file imports it, so an orphan cluster — dead files
 * importing each other — is reported too, not just files nobody imports.
 *
 * Run: bun scripts/find-unused-files.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Loaded by Next.js / tooling, not by an import — always a root. */
const ENTRY_DIRECTORIES = ['app/', 'tests/'];
const ENTRY_FILE_PATTERN =
  /^(middleware|instrumentation|next\.config|drizzle\.config|eslint\.config|prettier\.config|postcss\.config|tailwind\.config)\.[a-z]+$/;

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
  ENTRY_FILE_PATTERN.test(path.posix.basename(key)) ||
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
  const source = readFileSync(path.join(ROOT, key), 'utf8');
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

const unused = codeFiles
  .filter((key) => !reachable.has(key))
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
