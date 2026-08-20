// The two ID-generation implementations under measurement.
//
// Unlike bench/sqlite (two runtimes, two drivers — no single process can load
// both), `uuid`'s v7 and `Bun.randomUUIDv7` are both plain function calls
// reachable from one Bun process. There is no cross-runtime split to mirror
// here, so this benchmark has one shared/ directory and one entry point
// instead of a folder per implementation.
//
// `lib/id.ts` (`generateUuidV7`) is not benchmarked directly: it is a
// zero-overhead pass-through to `uuid`'s `v7()` (see that file), so measuring
// `v7()` itself already measures the seam's current cost.

import { createRequire } from 'node:module';

import { v7 as uuidV7 } from 'uuid';

const require = createRequire(import.meta.url);
const { version: uuidPackageVersion } = require('uuid/package.json');

export const GENERATORS = [
  {
    name: 'uuid.v7',
    slug: 'uuid-pkg',
    version: uuidPackageVersion,
    generate: uuidV7,
  },
  {
    name: 'Bun.randomUUIDv7',
    slug: 'bun-native',
    version: Bun.version,
    generate: () => Bun.randomUUIDv7(),
  },
];
