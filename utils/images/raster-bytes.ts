/**
 * Byte-level facts about the raster formats this application admits.
 *
 * A leaf module because two boundaries ask the same questions of the same bytes:
 * `lib/r2/upload-helper.ts` checks an uploaded file, and
 * `utils/images/svg-optimizer.ts` checks a raster inlined into an SVG as a
 * `data:` URI. Those two paths answered differently while the checks lived in
 * only one of them — an animated GIF, APNG or animated WebP was refused at the
 * door and admitted inside an `<image href="data:…">`.
 *
 * `Uint8Array` rather than `Buffer`: the sanitizer half runs with no Node
 * globals, and every `Buffer` already IS a `Uint8Array`.
 */

/** The raster types this application stores, and the bytes that identify them. */
const RASTER_MAGIC_BYTES = {
  'image/png': {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    offset: 0,
  },
  'image/webp': {
    bytes: [0x52, 0x49, 0x46, 0x46],
    offset: 0,
    secondary: { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  },
} as const;

type RasterMimeType = keyof typeof RASTER_MAGIC_BYTES;

export function hasRasterSignature(
  mimeType: string
): mimeType is RasterMimeType {
  return Object.hasOwn(RASTER_MAGIC_BYTES, mimeType);
}

function matchesAt(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[]
): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

/** Do these bytes carry the signature `mimeType` declares? */
export function matchesMagicBytes(
  bytes: Uint8Array,
  mimeType: string
): boolean {
  if (!hasRasterSignature(mimeType)) return false;
  const signature = RASTER_MAGIC_BYTES[mimeType];
  if (!matchesAt(bytes, signature.offset, signature.bytes)) return false;

  const secondary = 'secondary' in signature ? signature.secondary : undefined;
  return !secondary || matchesAt(bytes, secondary.offset, secondary.bytes);
}

function readU32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean
): number | null {
  if (offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, littleEndian);
}

function fourCC(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let index = 0; index < 4; index++)
    out += String.fromCodePoint(bytes[offset + index] ?? 0);
  return out;
}

/**
 * The pixel dimensions these bytes declare, or `null` when they cannot be read.
 *
 * Read from the header rather than by decoding: the point is to refuse a
 * decompression bomb BEFORE anything allocates its raster, and a 25 MP image is
 * ~100 MB of RGBA whoever decodes it. `null` means "not stated in a form this
 * knows", which every caller must treat as unusable rather than as unlimited.
 */
export function rasterDimensions(
  bytes: Uint8Array,
  mimeType: string
): { width: number; height: number } | null {
  if (!matchesMagicBytes(bytes, mimeType)) return null;
  return mimeType === 'image/png'
    ? pngDimensions(bytes)
    : webpDimensions(bytes);
}

/** `IHDR` is required to be the first chunk, so its payload is at a fixed offset. */
function pngDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  if (fourCC(bytes, 12) !== 'IHDR') return null;
  const width = readU32(bytes, 16, false);
  const height = readU32(bytes, 20, false);
  return width && height ? { width, height } : null;
}

/**
 * WebP states its size three different ways, one per coding.
 *
 * `VP8 ` (lossy) carries 14-bit dimensions after a three-byte start code;
 * `VP8L` (lossless) packs `width-1` and `height-1` into 28 bits; `VP8X`
 * (extended) states a 24-bit canvas size minus one. A file whose first chunk is
 * none of the three is unreadable here, which is `null`.
 */
function webpDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  const chunk = fourCC(bytes, 12);

  if (chunk === 'VP8 ') {
    if (!matchesAt(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    // Frame tag (3) + start code (3) precede the two 14-bit dimensions.
    const width = readU16(bytes, 26);
    const height = readU16(bytes, 28);
    if (width === null || height === null) return null;
    const decodedWidth = width & 0x3f_ff;
    const decodedHeight = height & 0x3f_ff;
    return decodedWidth && decodedHeight
      ? { width: decodedWidth, height: decodedHeight }
      : null;
  }

  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const packed = readU32(bytes, 21, true);
    if (packed === null) return null;
    return {
      width: (packed & 0x3f_ff) + 1,
      height: ((packed >> 14) & 0x3f_ff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    const width = readU24(bytes, 24);
    const height = readU24(bytes, 27);
    return width === null || height === null
      ? null
      : { width: width + 1, height: height + 1 };
  }

  return null;
}

/** Little-endian 16-bit, for the two `VP8 ` dimensions. */
function readU16(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** Little-endian 24-bit, which only the `VP8X` canvas size uses. */
function readU24(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 > bytes.length) return null;
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

const WEBP_ANIMATION_FLAG = 0x02;

/**
 * The flag lives in bit 1 of the first byte of the `VP8X` chunk, which a simple
 * (non-extended) WebP does not have at all — hence the chunk walk rather than a
 * fixed offset. Structure per the WebP container spec: `RIFF<size>WEBP` then
 * 8-byte-headed chunks, each padded to an even length.
 *
 * Refusing here also keeps the decode path narrow: `Bun.Image` cannot decode
 * animated WebP at all (`ERR_IMAGE_DECODE_FAILED`), and a rejection with a
 * message beats a 500 four layers down.
 */
function isAnimatedWebp(bytes: Uint8Array): boolean {
  let offset = 12; // past `RIFF<size>WEBP`
  while (offset + 8 <= bytes.length) {
    const fourcc = fourCC(bytes, offset);
    const size = readU32(bytes, offset + 4, true);
    if (size === null) return false;
    if (fourcc === 'VP8X')
      return ((bytes[offset + 8] ?? 0) & WEBP_ANIMATION_FLAG) !== 0;
    // An `ANIM` chunk without a VP8X flag is malformed, but treat it as animated
    // rather than reasoning about which of two contradictory headers wins.
    if (fourcc === 'ANIM' || fourcc === 'ANMF') return true;
    // A zero-length chunk is LEGAL — an empty `XMP ` is the ordinary case — so
    // advance past its 8-byte header. Returning `false` here let a
    // standards-valid animated WebP through the admission check, to be refused
    // by the decoder with the wrong diagnosis after a full decode.
    offset += 8 + size + (size % 2);
  }
  return false;
}

/**
 * A PNG carrying an `acTL` chunk before the first `IDAT`: the APNG animation
 * control.
 *
 * Structure per the PNG spec: an 8-byte signature, then chunks of
 * `<4-byte big-endian length><4-byte type><data><4-byte CRC>`. Position matters —
 * a decoder ignores `acTL` that appears after `IDAT`, so an `acTL` there does not
 * make the file animated.
 */
function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = 8; // past the 8-byte signature
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset, false);
    if (length === null) return false;
    const type = fourCC(bytes, offset + 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length; // length + type + data + CRC
  }
  return false;
}

/**
 * Animated uploads are not a feature of this application, and the refusal is
 * declared ONCE for every admitted format rather than per format.
 *
 * It used to be WebP-only, and the cost of that was exactly what the WebP branch
 * exists to prevent: an APNG is conventionally named `.png` and declared
 * `image/png`, so it was admitted, flattened to its first frame, and answered
 * `200` with no explanation. A reader checking "is animation rejected?" found
 * `isAnimatedWebp` and stopped.
 *
 * SVG is absent because it carries no magic bytes — `sanitizeSvg` refuses
 * `ANIMATION_ELEMENTS` and `processImage` maps that to the same message.
 */
const ANIMATION_CHECKS = new Map<string, (bytes: Uint8Array) => boolean>([
  ['image/png', isAnimatedPng],
  ['image/webp', isAnimatedWebp],
]);

export function isAnimatedRaster(bytes: Uint8Array, mimeType: string): boolean {
  return ANIMATION_CHECKS.get(mimeType)?.(bytes) ?? false;
}
