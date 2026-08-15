/**
 * Script to scan TypeScript files for TypeScript silencing / non-null assertions (!).
 *
 * Scans for:
 * 1. Non-null assertion operators (`expr!`, `obj!.prop`, `fn()!`)
 * 2. Definite assignment assertions (`prop!: Type`, `let x!: Type`)
 * 3. TypeScript suppression comments (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`)
 *
 * Usage:
 *   bun scripts/find-non-null-assertions.ts
 *   bun scripts/find-non-null-assertions.ts --fail       (Exits with code 1 if found)
 *   bun scripts/find-non-null-assertions.ts --json       (Outputs JSON result)
 *   bun scripts/find-non-null-assertions.ts --comments   (Includes @ts- comments in scan)
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

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
  'public',
]);

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

// Terminal ANSI formatting. Module scope: several of these were declared in the
// middle of `main`, after an early return, so half the palette was unreachable
// from the JSON path that also wants none of it.
const reset = '\u{1B}[0m';
const bold = '\u{1B}[1m';
const red = '\u{1B}[31m';
const yellow = '\u{1B}[33m';
const cyan = '\u{1B}[36m';
const gray = '\u{1B}[90m';
const green = '\u{1B}[32m';

// CLI Options
const args = new Set(process.argv.slice(2));
const FAIL_ON_FOUND = args.has('--fail');
const OUTPUT_JSON = args.has('--json');
const INCLUDE_COMMENTS = args.has('--comments') || args.has('--all');

interface MatchLocation {
  file: string;
  line: number;
  column: number;
  type: 'non-null-assertion' | 'definite-assignment' | 'ts-comment';
  snippet: string;
}

const toRelativePath = (absolutePath: string) =>
  path.relative(ROOT, absolutePath).replaceAll('\\', '/');

const scanDirectory = (dirPath: string, fileList: string[] = []): string[] => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirPath is derived from ROOT by recursive descent, never from input
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        scanDirectory(fullPath, fileList);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (TS_EXTENSIONS.has(ext) && !entry.name.endsWith('.d.ts')) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
};

const findSilencersInFile = (filePath: string): MatchLocation[] => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath comes from scanDirectory's walk of ROOT, never from input
  const content = readFileSync(filePath, 'utf8');
  const relativePath = toRelativePath(filePath);
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const matches: MatchLocation[] = [];

  // Helper to get line & column from node
  const getLoc = (pos: number) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
    return { line: line + 1, column: character + 1 };
  };

  // Helper to extract the single-line snippet around node
  const getLineSnippet = (line: number) => {
    const lines = content.split(/\r?\n/);
    return (lines[line - 1] || '').trim();
  };

  // AST Visitor
  const visit = (node: ts.Node) => {
    // 1. Non-null assertion expression: e.g. `foo!`, `bar!.baz`
    if (ts.isNonNullExpression(node)) {
      const { line, column } = getLoc(node.end - 1);
      matches.push({
        file: relativePath,
        line,
        column,
        type: 'non-null-assertion',
        snippet: getLineSnippet(line),
      });
    }

    // 2. Definite assignment assertion: e.g. `class A { name!: string }` or `let x!: string`
    if (
      (ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.exclamationToken
    ) {
      const { line, column } = getLoc(node.exclamationToken.pos);
      matches.push({
        file: relativePath,
        line,
        column,
        type: 'definite-assignment',
        snippet: getLineSnippet(line),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  // 3. Optional: Search for TS suppression comments (@ts-ignore, @ts-expect-error, @ts-nocheck)
  if (INCLUDE_COMMENTS) {
    const commentRegex =
      /\/\/\s*@ts-(ignore|expect-error|nocheck)|\/\*\s*@ts-(ignore|expect-error|nocheck)/g;
    const lines = content.split(/\r?\n/);
    lines.forEach((lineText, idx) => {
      if (commentRegex.test(lineText)) {
        matches.push({
          file: relativePath,
          line: idx + 1,
          column: lineText.search(/@ts-/),
          type: 'ts-comment',
          snippet: lineText.trim(),
        });
      }
    });
  }

  return matches;
};

const main = () => {
  const files = scanDirectory(ROOT);
  const allMatches: MatchLocation[] = [];

  for (const file of files) {
    const matches = findSilencersInFile(file);
    allMatches.push(...matches);
  }

  if (OUTPUT_JSON) {
    console.log(JSON.stringify(allMatches, null, 2));
    // eslint-disable-next-line unicorn/no-process-exit -- CLI entry point: the exit code IS this tool's result contract, the case the rule excepts
    if (FAIL_ON_FOUND && allMatches.length > 0) process.exit(1);
    return;
  }

  console.log(
    `\n${bold}🔍 Searching for TypeScript silencers (!)...${reset}\n`
  );

  if (allMatches.length === 0) {
    console.log(
      `${green}✨ Great job! No TypeScript silencers (! operator) found across ${files.length} scanned files.${reset}\n`
    );
    // eslint-disable-next-line unicorn/no-process-exit -- CLI entry point: the exit code IS this tool's result contract, the case the rule excepts
    process.exit(0);
  }

  // Group by file
  const grouped = new Map<string, MatchLocation[]>();
  for (const match of allMatches) {
    const list = grouped.get(match.file) || [];
    list.push(match);
    grouped.set(match.file, list);
  }

  // Counted by tallying the discriminant rather than branching on it: an
  // if/else chain trips `prefer-switch`, and a `switch` inside these nested
  // loops trips `no-break-in-nested-loop`. A keyed tally needs neither.
  const counts: Record<MatchLocation['type'], number> = {
    'non-null-assertion': 0,
    'definite-assignment': 0,
    'ts-comment': 0,
  };

  grouped.forEach((matches, file) => {
    console.log(
      `${cyan}${bold}${file}${reset} ${gray}(${matches.length} occurrence${matches.length > 1 ? 's' : ''})${reset}`
    );
    for (const m of matches) {
      counts[m.type]++;

      const typeLabel =
        m.type === 'non-null-assertion'
          ? `${red}Non-Null Assertion (!)${reset}`
          : m.type === 'definite-assignment'
            ? `${yellow}Definite Assignment (!:)${reset}`
            : `${yellow}TS Directive Comment${reset}`;

      console.log(`  ${gray}Line ${m.line}:${m.column}${reset} [${typeLabel}]`);
      console.log(`    ${gray}└─>${reset} ${m.snippet}`);
    }
    console.log('');
  });

  console.log(`${bold}──────── Summary ────────${reset}`);
  console.log(`Files scanned:              ${files.length}`);
  console.log(`Files with silencers:       ${grouped.size}`);
  console.log(
    `Non-Null Assertions (!):    ${red}${counts['non-null-assertion']}${reset}`
  );
  console.log(
    `Definite Assignments (!:):  ${yellow}${counts['definite-assignment']}${reset}`
  );
  if (INCLUDE_COMMENTS) {
    console.log(
      `TS Suppression Comments:    ${yellow}${counts['ts-comment']}${reset}`
    );
  }
  console.log(
    `Total occurrences:          ${bold}${allMatches.length}${reset}\n`
  );

  if (FAIL_ON_FOUND) {
    console.error(
      `${red}❌ Failure: TypeScript silencers found and --fail flag was supplied.${reset}`
    );
    // eslint-disable-next-line unicorn/no-process-exit -- CLI entry point: the exit code IS this tool's result contract, the case the rule excepts
    process.exit(1);
  }
};

main();
