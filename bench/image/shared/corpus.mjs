// The inputs every scenario runs against, generated deterministically so a
// rerun compares like with like.
//
// Two rules shaped this list:
//
// 1. **Only what the route actually accepts.** `ALLOWED_IMAGE_TYPES` in
//    `lib/r2/upload-helper.ts` is PNG, WebP and SVG, and `validateMagicBytes`
//    rejects a mismatch before either library sees the bytes. So there is no
//    JPEG here, no HEIC, no AVIF and no TIFF — measuring formats this
//    application refuses would inflate the comparison with cases that cannot
//    occur.
// 2. **Content that compresses differently.** A flat-colour test image makes
//    both encoders look identical (measured: byte-for-byte equal output), which
//    is an artefact of the content, not a finding. Photographic noise, smooth
//    gradients and screenshot-like flat blocks are the three shapes real uploads
//    take and they land in different places on the size/quality curve.
//
// `sharp` is used as the GENERATOR here, which is deliberate and worth naming:
// generating the corpus is not the thing under test, and a PNG is a PNG once
// written. The alternative — hand-encoding PNGs — would put a second untested
// encoder between the corpus and the result.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

// Bump when a generator below changes, so a stale cache cannot be mistaken for
// a corpus the current code would produce.
export const CORPUS_VERSION = 1;

/**
 * Deterministic LCG. `Math.random()` would make every run's corpus different,
 * and encoded size is exactly the quantity most sensitive to that.
 */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** Photographic: broad gradient + local structure + per-pixel noise. */
function photoPixels(width, height, channels, seed) {
  const random = rng(seed);
  const px = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      px[i] = Math.min(
        255,
        (x / width) * 180 + Math.sin(y / 90) * 30 + random() * 30
      );
      px[i + 1] = Math.min(
        255,
        90 + Math.sin(x / 55) * 60 + (y / height) * 60 + random() * 30
      );
      px[i + 2] = Math.min(
        255,
        (y / height) * 200 + Math.cos(x / 120) * 25 + random() * 30
      );
      if (channels === 4) {
        // Soft alpha ramp with a hard cut, so both an anti-aliased edge and a
        // fully transparent region are present.
        px[i + 3] =
          x < width * 0.15 ? 0 : Math.min(255, 60 + (x / width) * 195);
      }
    }
  }
  return px;
}

/** Screenshot-like: large flat regions, hard edges, text-shaped stripes. */
function uiPixels(width, height, seed) {
  const random = rng(seed);
  const px = Buffer.alloc(width * height * 3, 0xf4);
  const put = (x, y, r, g, b) => {
    const i = (y * width + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sidebar = x < width * 0.18;
      const header = y < height * 0.08;
      if (sidebar) put(x, y, 0x1e, 0x29, 0x39);
      else if (header) put(x, y, 0xff, 0xff, 0xff);
      // Text-shaped rows: short dark runs on a light background.
      else if (y % 24 < 9 && x % 140 < 96 + Math.floor(random() * 20))
        put(x, y, 0x33, 0x38, 0x40);
    }
  }
  return px;
}

async function generate(name) {
  switch (name) {
    // 12 MP, the shape a phone photo arrives in — and the case the optimize
    // loop has to iterate on.
    case 'photo-4000x3000.png':
      return sharp(photoPixels(4000, 3000, 3, 1), {
        raw: { width: 4000, height: 3000, channels: 3 },
      })
        .png()
        .toBuffer();
    case 'photo-1600x1200.png':
      return sharp(photoPixels(1600, 1200, 3, 2), {
        raw: { width: 1600, height: 1200, channels: 3 },
      })
        .png()
        .toBuffer();
    // Same pixels as above, arriving already WebP-encoded: the re-encode path.
    case 'photo-1600x1200.webp':
      return sharp(photoPixels(1600, 1200, 3, 2), {
        raw: { width: 1600, height: 1200, channels: 3 },
      })
        .webp({ quality: 92 })
        .toBuffer();
    case 'ui-1920x1080.png':
      return sharp(uiPixels(1920, 1080, 3), {
        raw: { width: 1920, height: 1080, channels: 3 },
      })
        .png()
        .toBuffer();
    case 'alpha-1200x900.png':
      return sharp(photoPixels(1200, 900, 4, 4), {
        raw: { width: 1200, height: 900, channels: 4 },
      })
        .png()
        .toBuffer();
    // Already under the size target on the first attempt — the common case for
    // avatars and icons, and the one where per-call overhead is all there is.
    case 'tiny-64x64.png':
      return sharp(photoPixels(64, 64, 3, 5), {
        raw: { width: 64, height: 64, channels: 3 },
      })
        .png()
        .toBuffer();
    case 'gray-1200x900.png':
      return sharp(photoPixels(1200, 900, 3, 6), {
        raw: { width: 1200, height: 900, channels: 3 },
      })
        .greyscale()
        .png({ colours: 256 })
        .toBuffer();
    case 'palette-800x600.png':
      return sharp(uiPixels(800, 600, 7), {
        raw: { width: 800, height: 600, channels: 3 },
      })
        .png({ palette: true, colours: 64 })
        .toBuffer();
    case 'depth16-800x600.png':
      return sharp(photoPixels(800, 600, 3, 8), {
        raw: { width: 800, height: 600, channels: 3 },
      })
        .toColourspace('rgb16')
        .png()
        .toBuffer();
    case 'interlaced-800x600.png':
      return sharp(photoPixels(800, 600, 3, 9), {
        raw: { width: 800, height: 600, channels: 3 },
      })
        .png({ progressive: true })
        .toBuffer();
    // Exactly at MAX_IMAGE_PIXELS (25 MP) and only a few KB on disk: admitted
    // by both pixel guards, then 100 MB of RGBA once decoded.
    case 'atcap-5000x5000.png':
      return sharp({
        create: {
          width: 5000,
          height: 5000,
          channels: 3,
          background: '#101010',
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
    // Over the cap: must be refused, not resized.
    case 'overcap-6000x5000.png':
      return sharp({
        create: {
          width: 6000,
          height: 5000,
          channels: 3,
          background: '#202020',
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
    default:
      throw new Error(`unknown corpus entry: ${name}`);
  }
}

/**
 * The performance/quality corpus. `label` is what the tables print; `kind`
 * groups the entries a scenario should include — `perf` entries are the ones
 * the route realistically processes, `decode` entries exist to prove both
 * libraries read the same PNG variants.
 */
export const CORPUS = [
  { name: 'photo-4000x3000.png', label: 'photo 12MP', kind: 'perf' },
  { name: 'photo-1600x1200.png', label: 'photo 2MP', kind: 'perf' },
  { name: 'photo-1600x1200.webp', label: 'webp in 2MP', kind: 'perf' },
  { name: 'ui-1920x1080.png', label: 'screenshot 2MP', kind: 'perf' },
  { name: 'alpha-1200x900.png', label: 'alpha 1MP', kind: 'perf' },
  { name: 'tiny-64x64.png', label: 'tiny 64px', kind: 'perf' },
  { name: 'gray-1200x900.png', label: 'greyscale', kind: 'decode' },
  { name: 'palette-800x600.png', label: 'palette png', kind: 'decode' },
  { name: 'depth16-800x600.png', label: '16-bit png', kind: 'decode' },
  { name: 'interlaced-800x600.png', label: 'interlaced png', kind: 'decode' },
  { name: 'atcap-5000x5000.png', label: '25MP at cap', kind: 'decode' },
  // `hostile` entries are generated but kept out of the parity and performance
  // sets: both libraries are supposed to REFUSE this one, and two different
  // refusal messages are not a metadata disagreement.
  { name: 'overcap-6000x5000.png', label: '30MP over cap', kind: 'hostile' },
];

/**
 * Inputs that must be REFUSED, or whose refusal shape matters. Built here
 * rather than in the checks file so the bytes are cached with the rest of the
 * corpus and a run does not re-forge them.
 */
export function hostileInputs(validPng) {
  const truncated = Buffer.from(validPng.subarray(0, 512));

  // A 33-byte-header lie: IHDR claims 60000×60000 (3.6 gigapixels) with a
  // single IDAT of nothing. The point is which library allocates before it
  // checks, so the file has to be small and the header has to be valid CRC.
  const headerLie = forgePngHeader(60_000, 60_000);

  return [
    {
      name: 'truncated-png',
      label: 'truncated PNG (512 B of a valid file)',
      bytes: truncated,
      expect: 'reject',
    },
    {
      name: 'empty',
      label: 'zero-byte input',
      bytes: Buffer.alloc(0),
      expect: 'reject',
    },
    {
      name: 'header-lie',
      label: 'PNG header claiming 60000x60000',
      bytes: headerLie,
      expect: 'reject',
    },
    {
      name: 'svg',
      label: 'SVG (allowed upload, never decoded since 2026-08-21)',
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">' +
          '<rect width="240" height="120" fill="#2255aa"/>' +
          '<circle cx="120" cy="60" r="40" fill="#ffcc00"/></svg>',
        'utf8'
      ),
      // `report`, not `decode`: an SVG upload is sanitised, minified and stored
      // as-is now, so whether a raster decoder accepts it is a property of the
      // library, not a requirement of this application.
      expect: 'report',
    },
    {
      name: 'random-bytes',
      label: '4 KiB of random bytes',
      bytes: (() => {
        const random = rng(99);
        const buf = Buffer.alloc(4096);
        for (let i = 0; i < buf.length; i++)
          buf[i] = Math.floor(random() * 256);
        return buf;
      })(),
      expect: 'reject',
    },
  ];
}

/**
 * An animated WebP, assembled by hand.
 *
 * It has to be hand-assembled: `sharp`'s own animated output needs a
 * `pageHeight`-tagged input and the installed 0.35 build wrote a single tall
 * still instead (measured — `pages` came back `undefined` both ways), so there
 * is no way to author one with the libraries already here. The frames
 * themselves ARE sharp-encoded — only the RIFF container (`VP8X` with the
 * animation flag, `ANIM`, one `ANMF` per frame) is written here, and libvips
 * reads the result back as `pages: 3`, which is the evidence that the container
 * is well-formed rather than merely accepted.
 *
 * Why it is in the corpus at all: `image/webp` is an allowed upload type and
 * `validateMagicBytes` only checks `RIFF`/`WEBP`, so a user can upload one
 * today. What each library does with it is therefore live behaviour, not a
 * hypothetical.
 */
async function animatedWebp(width, height, backgrounds, durationMs = 100) {
  const u24 = (n) => {
    const b = Buffer.alloc(3);
    b.writeUIntLE(n, 0, 3);
    return b;
  };
  const chunk = (fourcc, payload) => {
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, 'ascii');
    head.writeUInt32LE(payload.length, 4);
    return Buffer.concat([
      head,
      payload,
      payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
    ]);
  };
  const findChunk = (webp, fourcc) => {
    let offset = 12;
    while (offset + 8 <= webp.length) {
      const id = webp.toString('ascii', offset, offset + 4);
      const size = webp.readUInt32LE(offset + 4);
      if (id === fourcc) return webp.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size % 2);
    }
    return null;
  };

  const frames = [];
  for (const background of backgrounds) {
    const still = await sharp({
      create: { width, height, channels: 3, background },
    })
      .webp({ quality: 80 })
      .toBuffer();
    const vp8 = findChunk(still, 'VP8 ');
    if (!vp8) throw new Error('animated corpus: no VP8 chunk in frame');
    frames.push(
      chunk(
        'ANMF',
        Buffer.concat([
          u24(0),
          u24(0),
          u24(width - 1),
          u24(height - 1),
          u24(durationMs),
          Buffer.from([0]),
          chunk('VP8 ', vp8),
        ])
      )
    );
  }

  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02; // ANIMATION
  u24(width - 1).copy(vp8x, 4);
  u24(height - 1).copy(vp8x, 7);
  const anim = Buffer.alloc(6);
  anim.writeUInt32LE(0xffffffff, 0);
  anim.writeUInt16LE(0, 4); // loop forever

  const body = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    chunk('VP8X', vp8x),
    chunk('ANIM', anim),
    ...frames,
  ]);
  const out = Buffer.alloc(8 + body.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(body.length, 4);
  body.copy(out, 8);
  return out;
}

/**
 * Inputs whose handling differs between the two libraries, or whose refusal
 * shape matters. Async because two of them are encoded rather than forged.
 */
export async function behaviourInputs(validPng) {
  return [
    {
      name: 'animated-webp',
      label: 'animated WebP, 3 frames (an allowed upload type)',
      bytes: await animatedWebp(160, 120, ['#cc3333', '#33cc55', '#3355cc']),
    },
    {
      name: 'icc-p3',
      label: 'PNG carrying a Display P3 ICC profile',
      bytes: await sharp(validPng).withMetadata({ icc: 'p3' }).png().toBuffer(),
    },
  ];
}

/** Minimal valid PNG stream whose IHDR declares `width`×`height`. */
function forgePngHeader(width, height) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk(
      'IDAT',
      Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])
    ),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * Generates the corpus once and caches it under `results/corpus/`, which is
 * gitignored like every other bench output. Generation of the 12 MP entry alone
 * is seconds, and a scenario that regenerates per run measures the generator.
 */
export async function loadCorpus(cacheDir, wanted = null) {
  const dir = join(cacheDir, `corpus-v${CORPUS_VERSION}`);
  mkdirSync(dir, { recursive: true });

  const entries = [];
  for (const entry of CORPUS) {
    if (wanted && !wanted.includes(entry.kind)) continue;
    const path = join(dir, entry.name);
    let bytes;
    if (existsSync(path)) bytes = readFileSync(path);
    else {
      bytes = await generate(entry.name);
      writeFileSync(path, bytes);
    }
    entries.push({ ...entry, bytes });
  }
  return entries;
}
