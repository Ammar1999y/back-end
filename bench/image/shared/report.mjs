// Console tables, check printing and JSON persistence — same conventions as
// bench/sqlite and bench/uuid (fixed-width padded columns, one header block,
// one `results/latest.json` per run).
//
// One generic table printer rather than one per scenario: this benchmark has
// seven scenarios with different columns, and seven near-identical printers is
// how a formatting fix ends up applied to six of them.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function pad(text, width, align = 'right') {
  const value = String(text);
  if (value.length >= width) return value;
  return align === 'left' ? value.padEnd(width) : value.padStart(width);
}

/**
 * @param {string} title
 * @param {Array<{label: string, width: number, align?: string, render: (row: any) => string}>} columns
 * @param {any[]} rows
 */
export function printTable(title, columns, rows) {
  console.log(`\n### ${title}`);
  const header = columns
    .map((c) => pad(c.label, c.width, c.align ?? 'right'))
    .join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    console.log(
      columns
        .map((c) => pad(c.render(row), c.width, c.align ?? 'right'))
        .join('  ')
    );
  }
}

export function printChecks(title, results) {
  console.log(`\n### ${title}`);
  let failedCritical = 0;
  for (const result of results) {
    // A passing non-critical entry carries no verdict — it is a measurement in
    // check shape — so it says INFO rather than PASS.
    const status = result.pass
      ? result.critical
        ? 'PASS'
        : 'INFO'
      : result.critical
        ? 'FAIL (CRITICAL)'
        : 'FAIL';
    if (!result.pass && result.critical) failedCritical++;
    console.log(
      `${status.padEnd(16)} ${String(result.name).padEnd(62)} ${result.detail}`
    );
  }
  return failedCritical;
}

export function printHeader(meta) {
  console.log('='.repeat(104));
  console.log(`runtime         : bun ${meta.bun}`);
  console.log(
    `platform        : ${meta.platform} ${meta.arch}  cpus=${meta.cpus}`
  );
  console.log(`sharp           : ${meta.sharp}  (libvips ${meta.libvips})`);
  console.log(`Bun.Image       : backend=${meta.imageBackend}`);
  console.log(`harness         : v${meta.harnessVersion}   mode: ${meta.mode}`);
  console.log(
    `app constants   : MAX_IMAGE_PIXELS=${meta.maxImagePixels.toLocaleString('en-US')}  ` +
      `upload cap=${meta.maxImageSizeMb} MB  optimize target=${meta.targetSize.toLocaleString('en-US')} B`
  );
  console.log(`timestamp       : ${meta.timestamp}`);
  console.log('='.repeat(104));
}

export function saveJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\nresults written: ${path}`);
}
