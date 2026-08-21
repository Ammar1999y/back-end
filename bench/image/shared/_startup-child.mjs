// Spawned by the `startup` scenario. Underscore-prefixed so it reads as a
// fixture rather than an entry point, matching the convention the test-strategy
// document sets for spawned children.
//
// Measures what a cold process pays before it can process its first image:
// module load, and the resident memory that load costs. `sharp` is a native
// addon — a `.node` binary plus libvips and its dependency chain — and
// `Bun.Image` is compiled into the runtime, so this is the one number that
// cannot be measured in-process by the benchmark itself.
//
// Usage: `bun _startup-child.mjs sharp|bun`

const engine = process.argv[2];
const rssBefore = process.memoryUsage.rss();
const started = Bun.nanoseconds();

let loadMs = 0;
let firstOpMs = 0;

// A 4x4 PNG, inline: the child must not depend on the corpus cache existing,
// and "first op" only has to prove the codec path is warm.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQI12MwTpsJRwzEcQDrIxMhCQqhZgAAAABJRU5ErkJggg==',
  'base64'
);

if (engine === 'sharp') {
  const { default: sharp } = await import('sharp');
  loadMs = (Bun.nanoseconds() - started) / 1e6;
  const opStarted = Bun.nanoseconds();
  await sharp(TINY_PNG).resize(2).webp({ quality: 80 }).toBuffer();
  firstOpMs = (Bun.nanoseconds() - opStarted) / 1e6;
} else {
  // Nothing to import: reading the global is the whole "load".
  void Bun.Image;
  loadMs = (Bun.nanoseconds() - started) / 1e6;
  const opStarted = Bun.nanoseconds();
  await new Bun.Image(TINY_PNG).resize(2).webp({ quality: 80 }).bytes();
  firstOpMs = (Bun.nanoseconds() - opStarted) / 1e6;
}

console.log(
  JSON.stringify({
    engine,
    loadMs,
    firstOpMs,
    rssBefore,
    rssAfter: process.memoryUsage.rss(),
  })
);
