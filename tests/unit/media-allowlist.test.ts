/**
 * The document allowlist's byte-level checks, against synthesised containers
 * and — for the one property no synthesised file can carry — real ones.
 *
 * The synthesised fixtures are BUILT here rather than checked in: a real
 * `.docx` is a ZIP of a dozen XML parts, and what the checks read is the
 * central directory plus `[Content_Types].xml`, so a fixture that carries
 * exactly those and nothing else is both smaller and more honest about what is
 * being asserted. The same goes for the compound-file fixtures — a header, one
 * FAT sector, a directory and the one stream each check reads are the whole of
 * what `detectCompoundFile` walks. The exception is legacy Office encryption,
 * which lives inside those streams in a form only Office writes; for that the
 * Apache POI fixtures under `tests/fixtures/office` are used as they are.
 *
 * The property under test is the same for every row: the DECLARED type selects
 * the check, and the BYTES have to prove it. A `.docm` labelled as a `.docx`, a
 * ZIP with no content types, a compound file with a `Macros` storage, a content
 * type spelt with a character reference — each is a file a client can label
 * however it likes.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import {
  ALLOWED_MIME_TYPES,
  DISABLED_FILE_TYPES,
  DOC_MIME_TYPE,
  DOCX_MIME_TYPE,
  FILE_TYPE_TABLE,
  FILE_TYPES,
  fileTypeFor,
  mimeTypesOfKind,
  XLS_MIME_TYPE,
  XLSX_MIME_TYPE,
} from '@/lib/media/allowlist';
import { detectCompoundFile } from '@/lib/media/cfb';
import {
  detectOoxml,
  EXCEL_MAIN_CONTENT_TYPE,
  OOXML_MAX_ENTRIES,
  WORD_MAIN_CONTENT_TYPE,
} from '@/lib/media/ooxml';

const OFFICE_FIXTURES = path.join(import.meta.dir, '..', 'fixtures', 'office');

interface ZipEntryFixture {
  name: string;
  data: string | Uint8Array;
  /** 8 = deflate (what Office writes), 0 = stored. */
  method?: 0 | 8;
  /** Written into the LOCAL header instead of `name`; the central directory keeps `name`. */
  localName?: string;
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

/**
 * A minimal, valid ZIP: local headers, then the central directory, then the
 * end record. CRCs are zero — nothing under test verifies them, and a reader
 * that started to would fail this fixture loudly rather than pass it quietly.
 */
function buildZip(
  entries: readonly ZipEntryFixture[],
  options: { zip64Marker?: boolean } = {}
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const raw = Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(raw) : raw;

    const local = Buffer.concat([
      u32(0x04_03_4b_50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(stored.length),
      u32(raw.length),
      u16(localName.length),
      u16(0),
      localName,
      stored,
    ]);
    const central = Buffer.concat([
      u32(0x02_01_4b_50),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(stored.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const total = options.zip64Marker ? 0xff_ff : entries.length;
  const eocd = Buffer.concat([
    u32(0x06_05_4b_50),
    u16(0),
    u16(0),
    u16(total),
    u16(total),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, directory, eocd]);
}

function contentTypes(
  parts: ReadonlyArray<readonly [partName: string, contentType: string]>,
  options: {
    swapAttributes?: boolean;
    defaults?: readonly (readonly [string, string])[];
  } = {}
): string {
  const defaults = (
    options.defaults ?? [
      ['xml', 'application/xml'],
      ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
    ]
  )
    .map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`)
    .join('');
  const overrides = parts
    .map(([part, type]) =>
      options.swapAttributes
        ? `<Override ContentType="${type}" PartName="${part}"/>`
        : `<Override PartName="${part}" ContentType="${type}"/>`
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    `${defaults}${overrides}</Types>`
  );
}

const docx = (
  extra: ZipEntryFixture[] = [],
  xml = contentTypes([['/word/document.xml', WORD_MAIN_CONTENT_TYPE]])
) =>
  buildZip([
    { name: '[Content_Types].xml', data: xml },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'word/document.xml', data: '<w:document/>' },
    ...extra,
  ]);

const xlsx = (
  xml = contentTypes([['/xl/workbook.xml', EXCEL_MAIN_CONTENT_TYPE]])
) =>
  buildZip([
    { name: '[Content_Types].xml', data: xml },
    { name: 'xl/workbook.xml', data: '<workbook/>' },
  ]);

const TYPES_OPEN =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
const MAIN_OVERRIDE = `<Override PartName="/word/document.xml" ContentType="${WORD_MAIN_CONTENT_TYPE}"/>`;

const SECTOR = 512;
const MINI_SECTOR = 64;
const ENDOFCHAIN = 0xff_ff_ff_fe;
const FREESECT = 0xff_ff_ff_ff;
const FATSECT = 0xff_ff_ff_fd;

interface CfbEntryFixture {
  name: string;
  type: 'storage' | 'stream';
  data?: Uint8Array;
}

/**
 * A compound file with one FAT sector, a directory, and every stream's bytes
 * placed where a real writer puts them: a stream under the cutoff goes into the
 * mini stream (the root entry's chain, cut into 64-byte mini sectors and chained
 * through a mini FAT sector); anything else gets ordinary sectors. Both paths
 * are what `detectCompoundFile` has to walk to reach the FIB or the workbook.
 */
function buildCfb(
  entries: readonly CfbEntryFixture[],
  options: { badSignature?: boolean; miniStreamCutoff?: number } = {}
): Buffer {
  const cutoff = options.miniStreamCutoff ?? 4096;
  const all: Array<CfbEntryFixture & { root?: boolean }> = [
    { name: 'Root Entry', type: 'storage', root: true },
    ...entries,
  ];
  const directorySectors = Math.max(1, Math.ceil(all.length / 4));

  const sectors: Buffer[] = [];
  const fat: number[] = [];
  const allocate = (buffer: Buffer): number => {
    sectors.push(buffer);
    fat.push(FREESECT);
    return sectors.length - 1;
  };

  allocate(Buffer.alloc(SECTOR, 0xff));
  fat[0] = FATSECT;

  const directory = Buffer.alloc(SECTOR * directorySectors, 0);
  const directoryFirst = sectors.length;
  for (let index = 0; index < directorySectors; index++) {
    const sector = allocate(
      directory.subarray(index * SECTOR, (index + 1) * SECTOR)
    );
    fat[sector] = index + 1 < directorySectors ? sector + 1 : ENDOFCHAIN;
  }

  const chainOf = (data: Uint8Array): number => {
    let first = -1;
    let previous = -1;
    for (let index = 0; index * SECTOR < data.length; index++) {
      const block = Buffer.alloc(SECTOR, 0);
      Buffer.from(data.subarray(index * SECTOR, (index + 1) * SECTOR)).copy(
        block
      );
      const sector = allocate(block);
      if (first === -1) first = sector;
      if (previous !== -1) fat[previous] = sector;
      previous = sector;
    }
    if (previous !== -1) fat[previous] = ENDOFCHAIN;
    return first;
  };

  const placements: Array<{ start: number; size: number }> = [];
  const miniChunks: Buffer[] = [];
  const miniFat: number[] = [];
  for (const entry of all) {
    const data = entry.data;
    if (!data || data.length === 0) {
      placements.push({ start: entry.root ? ENDOFCHAIN : 0, size: 0 });
      continue;
    }
    if (data.length >= cutoff) {
      placements.push({ start: chainOf(data), size: data.length });
      continue;
    }
    const first = miniChunks.length;
    for (let index = 0; index * MINI_SECTOR < data.length; index++) {
      const block = Buffer.alloc(MINI_SECTOR, 0);
      Buffer.from(
        data.subarray(index * MINI_SECTOR, (index + 1) * MINI_SECTOR)
      ).copy(block);
      miniChunks.push(block);
      miniFat.push(
        (index + 1) * MINI_SECTOR < data.length ? miniChunks.length : ENDOFCHAIN
      );
    }
    placements.push({ start: first, size: data.length });
  }

  let miniFatSector = ENDOFCHAIN;
  let miniFatCount = 0;
  if (miniChunks.length > 0) {
    const miniFatBuffer = Buffer.alloc(SECTOR, 0xff);
    miniFat.forEach((value, index) =>
      miniFatBuffer.writeUInt32LE(value, index * 4)
    );
    miniFatSector = allocate(miniFatBuffer);
    fat[miniFatSector] = ENDOFCHAIN;
    miniFatCount = 1;
    const miniStream = Buffer.concat(miniChunks);
    placements[0] = { start: chainOf(miniStream), size: miniStream.length };
  }
  if (sectors.length > SECTOR / 4)
    throw new Error('fixture needs more than one FAT sector');

  const header = Buffer.alloc(SECTOR, 0);
  Buffer.from(
    options.badSignature
      ? [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]
      : [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  ).copy(header, 0);
  header.writeUInt16LE(0x3e, 24); // minor version
  header.writeUInt16LE(3, 26); // major version 3 → 512-byte sectors
  header.writeUInt16LE(0xff_fe, 28); // byte order
  header.writeUInt16LE(9, 30); // sector shift
  header.writeUInt16LE(6, 32); // mini sector shift
  header.writeUInt32LE(1, 44); // number of FAT sectors
  header.writeUInt32LE(directoryFirst, 48); // first directory sector
  header.writeUInt32LE(cutoff, 56); // mini stream cutoff
  header.writeUInt32LE(miniFatSector, 60); // first mini FAT sector
  header.writeUInt32LE(miniFatCount, 64); // number of mini FAT sectors
  header.writeUInt32LE(ENDOFCHAIN, 68); // first DIFAT sector
  header.writeUInt32LE(0, 72); // number of DIFAT sectors
  header.writeUInt32LE(0, 76); // DIFAT[0]: the FAT lives in sector 0
  for (let index = 1; index < 109; index++)
    header.writeUInt32LE(FREESECT, 76 + index * 4);

  all.forEach((entry, index) => {
    const base = index * 128;
    const name = Buffer.from(entry.name, 'utf16le');
    name.copy(directory, base, 0, Math.min(name.length, 62));
    directory.writeUInt16LE(Math.min(name.length, 62) + 2, base + 64);
    directory.writeUInt8(
      entry.root ? 5 : entry.type === 'storage' ? 1 : 2,
      base + 66
    );
    directory.writeUInt32LE(FREESECT, base + 68); // left sibling
    directory.writeUInt32LE(FREESECT, base + 72); // right sibling
    directory.writeUInt32LE(FREESECT, base + 76); // child
    const placement = placements[index] ?? { start: 0, size: 0 };
    directory.writeUInt32LE(placement.start, base + 116);
    directory.writeUInt32LE(placement.size, base + 120);
  });

  const fatBuffer = sectors[0];
  if (!fatBuffer) throw new Error('fixture has no FAT sector');
  fat.forEach((value, index) => fatBuffer.writeUInt32LE(value, index * 4));

  return Buffer.concat([header, ...sectors]);
}

/** A FIB base: `wIdent`, an `nFib`, and the flag word at offset 10. */
function fib(flags = 0, length = 64): Buffer {
  const out = Buffer.alloc(length, 0);
  out.writeUInt16LE(0xa5_ec, 0);
  out.writeUInt16LE(0x00_c1, 2);
  out.writeUInt16LE(flags, 10);
  return out;
}

const biff = (type: number, data: Buffer) =>
  Buffer.concat([u16(type), u16(data.length), data]);
const bof = () => biff(0x08_09, Buffer.alloc(16, 0));
const eof = () => biff(0x00_0a, Buffer.alloc(0));
const filePass = () => biff(0x00_2f, Buffer.alloc(6, 0));
/** `BoundSheet8`: `lbPlyPos`, `hsState`, `dt`, then the sheet name. */
function boundSheet(dt: number): Buffer {
  const data = Buffer.alloc(10, 0);
  data.writeUInt8(dt, 5);
  data.writeUInt8(2, 6);
  data.write('S1', 8, 'latin1');
  return biff(0x00_85, data);
}
const workbook = (...records: Buffer[]) =>
  Buffer.concat([bof(), ...records, eof()]);

const word = (extra: CfbEntryFixture[] = [], data: Uint8Array = fib()) =>
  buildCfb([
    { name: 'CompObj', type: 'stream' },
    { name: 'WordDocument', type: 'stream', data },
    { name: 'SummaryInformation', type: 'stream' },
    ...extra,
  ]);

const excel = (
  extra: CfbEntryFixture[] = [],
  data: Uint8Array = workbook(boundSheet(0))
) => buildCfb([{ name: 'Workbook', type: 'stream', data }, ...extra]);

describe('the allowlist table', () => {
  test('every known type carries a byte-level check and an extension', () => {
    for (const [mime, spec] of FILE_TYPE_TABLE) {
      expect(typeof spec.detect, mime).toBe('function');
      expect(spec.extension, mime).toMatch(/^[a-z0-9]+$/);
      expect(['image', 'document']).toContain(spec.kind);
    }
    const keys: string[] = [];
    for (const key of FILE_TYPES.keys()) keys.push(key);
    expect(ALLOWED_MIME_TYPES).toEqual(keys);
  });

  test('legacy Office is known, inspected, and held back from the allowlist', () => {
    for (const mime of DISABLED_FILE_TYPES) {
      expect(FILE_TYPE_TABLE.has(mime), mime).toBe(true);
      expect(FILE_TYPES.has(mime), mime).toBe(false);
      expect(fileTypeFor(mime), mime).toBeUndefined();
    }
    expect(ALLOWED_MIME_TYPES).not.toContain(DOC_MIME_TYPE);
    expect(ALLOWED_MIME_TYPES).not.toContain(XLS_MIME_TYPE);
    // Held back is not broken: re-enabling is one deletion from the set, and
    // the inspector behind each entry keeps working meanwhile.
    expect(FILE_TYPE_TABLE.get(DOC_MIME_TYPE)?.detect(word())).toEqual({
      ok: true,
    });
    expect(FILE_TYPE_TABLE.get(XLS_MIME_TYPE)?.detect(excel())).toEqual({
      ok: true,
    });
  });

  test('resolves a declared type by its essence, not its parameters or case', () => {
    expect(fileTypeFor('Application/PDF; charset=binary')?.extension).toBe(
      'pdf'
    );
    expect(fileTypeFor('application/x-msdownload')).toBeUndefined();
    expect(fileTypeFor('')).toBeUndefined();
  });

  test('kinds partition the allowlist', () => {
    const images = mimeTypesOfKind('image');
    const documents = mimeTypesOfKind('document');
    expect(images.length + documents.length).toBe(FILE_TYPES.size);
    expect(images).toEqual(['image/png', 'image/webp', 'image/svg+xml']);
    expect(documents).toEqual([
      'application/pdf',
      DOCX_MIME_TYPE,
      XLSX_MIME_TYPE,
    ]);
  });

  test('PDF is admitted by its signature and refused without it', () => {
    const pdf = fileTypeFor('application/pdf');
    expect(pdf?.detect(Buffer.from('%PDF-1.7\n%âãÏÓ', 'latin1'))).toEqual({
      ok: true,
    });
    expect(pdf?.detect(Buffer.from('MZ\u{90}\u{0} an executable'))).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(pdf?.detect(Buffer.from(' %PDF-1.7'))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });
});

describe('Office Open XML', () => {
  test('a plain .docx and a plain .xlsx are admitted', () => {
    expect(detectOoxml(docx(), 'word')).toEqual({ ok: true });
    expect(detectOoxml(xlsx(), 'excel')).toEqual({ ok: true });
    expect(fileTypeFor(DOCX_MIME_TYPE)?.detect(docx())).toEqual({ ok: true });
    expect(fileTypeFor(XLSX_MIME_TYPE)?.detect(xlsx())).toEqual({ ok: true });
  });

  test('attribute order inside [Content_Types].xml does not matter', () => {
    const swapped = contentTypes(
      [['/word/document.xml', WORD_MAIN_CONTENT_TYPE]],
      { swapAttributes: true }
    );
    expect(detectOoxml(docx([], swapped), 'word')).toEqual({ ok: true });
  });

  test('single quotes, a namespace prefix and a value containing ">" are all XML', () => {
    const singleQuoted = `<?xml version='1.0'?><Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Override PartName='/word/document.xml' ContentType='${WORD_MAIN_CONTENT_TYPE}'/></Types>`;
    expect(detectOoxml(docx([], singleQuoted), 'word')).toEqual({ ok: true });

    // Prefixed ELEMENT names are supported; the attributes stay unprefixed,
    // which is the only form the manifest grammar has.
    const prefixed = `<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types"><ct:Override PartName="/word/document.xml" ContentType="${WORD_MAIN_CONTENT_TYPE}"/></ct:Types>`;
    expect(detectOoxml(docx([], prefixed), 'word')).toEqual({ ok: true });

    // A ">" inside an earlier attribute must not hide the payload type behind it.
    const hidden = `${TYPES_OPEN}${MAIN_OVERRIDE}<Override Foo=">" PartName="/word/payload.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`;
    expect(
      detectOoxml(
        docx([{ name: 'word/payload.bin', data: 'inert' }], hidden),
        'word'
      )
    ).toEqual({ ok: false, reason: 'macros' });
  });

  test('character references are resolved before a content type is judged', () => {
    for (const spelt of [
      'application/vnd.ms-office.vba&#80;roject',
      'application/vnd.ms-office.vba&#x50;roject',
      'application/vnd.ms-office.vbaProj&#101;ct',
    ]) {
      const xml = `${TYPES_OPEN}${MAIN_OVERRIDE}<Override PartName="/word/payload.bin" ContentType="${spelt}"/></Types>`;
      expect(
        detectOoxml(
          docx([{ name: 'word/payload.bin', data: 'inert' }], xml),
          'word'
        ),
        spelt
      ).toEqual({ ok: false, reason: 'macros' });
    }
    // A reference the tokenizer cannot resolve is not "some other string": the
    // part is unreadable and the package is refused whole.
    const bogus = `${TYPES_OPEN}${MAIN_OVERRIDE}<Override PartName="/word/x.bin" ContentType="text/&bogus;"/></Types>`;
    expect(detectOoxml(docx([], bogus), 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
  });

  test('a namespaced or repeated attribute is refused, not folded onto the real one', () => {
    // `x:ContentType` and `ContentType` are two attributes under the namespace
    // rules. Keyed by their local part, the second overwrote the first and the
    // package declared a VBA type this reader never saw while a conforming
    // parser did.
    const namespaced = `${TYPES_OPEN}${MAIN_OVERRIDE}<Override xmlns:x="urn:review" PartName="/word/custom.bin" ContentType="application/vnd.ms-office.vbaProject" x:ContentType="application/octet-stream"/></Types>`;
    expect(
      detectOoxml(
        docx([{ name: 'word/custom.bin', data: 'inert' }], namespaced),
        'word'
      )
    ).toEqual({ ok: false, reason: 'container' });

    // A repeated name is a FATAL error in XML, so last-one-wins is this reader
    // disagreeing with every conforming one.
    const repeated = `${TYPES_OPEN}${MAIN_OVERRIDE}<Override PartName="/word/custom.bin" ContentType="application/vnd.ms-office.vbaProject" ContentType="text/plain"/></Types>`;
    expect(
      detectOoxml(
        docx([{ name: 'word/custom.bin', data: 'inert' }], repeated),
        'word'
      )
    ).toEqual({ ok: false, reason: 'container' });
  });

  test('a character reference outside XML’s Char production is a refusal, not a crash', () => {
    // `String.fromCodePoint` throws above the Unicode range, and the throw left
    // the detector through the one code path whose job is to survive hostile
    // bytes: the route answered 500 instead of refusing the document. The
    // forbidden-but-representable values were accepted silently, which is the
    // same disagreement with a conforming parser as an unknown entity.
    for (const spelt of [
      '&#xFFFFFF;',
      '&#x110000;',
      '&#1114112;',
      '&#0;',
      '&#xD800;',
      '&#x1;',
    ]) {
      const xml = `${TYPES_OPEN}${MAIN_OVERRIDE}<Override PartName="/word/x.bin" ContentType="text/plain${spelt}"/></Types>`;
      expect(detectOoxml(docx([], xml), 'word'), spelt).toEqual({
        ok: false,
        reason: 'container',
      });
    }
  });

  test('a DOCTYPE, an unquoted attribute or a stray "<" is not a package Office wrote', () => {
    const doctype = `<!DOCTYPE Types [<!ENTITY vba "application/vnd.ms-office.vbaProject">]>${TYPES_OPEN}${MAIN_OVERRIDE}</Types>`;
    expect(detectOoxml(docx([], doctype), 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
    const unquoted = `${TYPES_OPEN}<Override PartName=/word/document.xml ContentType="${WORD_MAIN_CONTENT_TYPE}"/></Types>`;
    expect(detectOoxml(docx([], unquoted), 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
    const stray = `${TYPES_OPEN}<Override PartName="/word/document.xml" ContentType="<${WORD_MAIN_CONTENT_TYPE}"/></Types>`;
    expect(detectOoxml(docx([], stray), 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
  });

  test('the main part has to exist, not merely be declared', () => {
    const declaredOnly = buildZip([
      {
        name: '[Content_Types].xml',
        data: contentTypes([['/word/document.xml', WORD_MAIN_CONTENT_TYPE]]),
      },
      { name: '_rels/.rels', data: '<Relationships/>' },
    ]);
    expect(detectOoxml(declaredOnly, 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
  });

  test('a part named twice, or a local header that disagrees with the directory, is refused', () => {
    const twice = buildZip([
      {
        name: '[Content_Types].xml',
        data: contentTypes([['/word/document.xml', WORD_MAIN_CONTENT_TYPE]]),
      },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'Word/Document.xml', data: '<w:document/>' },
    ]);
    expect(detectOoxml(twice, 'word')).toEqual({
      ok: false,
      reason: 'container',
    });

    const disagreeing = buildZip([
      {
        name: '[Content_Types].xml',
        localName: 'word/other.xml',
        data: contentTypes([['/word/document.xml', WORD_MAIN_CONTENT_TYPE]]),
      },
      { name: 'word/document.xml', data: '<w:document/>' },
    ]);
    expect(detectOoxml(disagreeing, 'word')).toEqual({
      ok: false,
      reason: 'container',
    });

    // Every admitted part, not only the manifest: the "declared main part is
    // present" rule is checked against the central directory's names, so a
    // main part whose local header names something else made two extractors
    // open different documents while this one said the package was fine.
    const mainPartDisagrees = buildZip([
      {
        name: '[Content_Types].xml',
        data: contentTypes([['/word/document.xml', WORD_MAIN_CONTENT_TYPE]]),
      },
      {
        name: 'word/document.xml',
        localName: 'word/different.xml',
        data: '<w:document/>',
      },
    ]);
    expect(detectOoxml(mainPartDisagrees, 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
  });

  test('a stored (uncompressed) content-types part reads the same', () => {
    const zip = buildZip([
      {
        name: '[Content_Types].xml',
        data: contentTypes([['/word/document.xml', WORD_MAIN_CONTENT_TYPE]]),
        method: 0,
      },
      { name: 'word/document.xml', data: '<w:document/>', method: 0 },
    ]);
    expect(detectOoxml(zip, 'word')).toEqual({ ok: true });
  });

  test('the declared family has to match the package', () => {
    // A spreadsheet labelled as a Word document, and the reverse.
    expect(detectOoxml(xlsx(), 'word')).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(detectOoxml(docx(), 'excel')).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  test('a macro-enabled package is refused however it is labelled', () => {
    const docm = contentTypes([
      [
        '/word/document.xml',
        'application/vnd.ms-word.document.macroEnabled.main+xml',
      ],
      ['/word/vbaProject.bin', 'application/vnd.ms-office.vbaProject'],
    ]);
    expect(
      detectOoxml(
        buildZip([
          { name: '[Content_Types].xml', data: docm },
          { name: 'word/document.xml', data: '<w:document/>' },
          { name: 'word/vbaProject.bin', data: 'vba' },
        ]),
        'word'
      )
    ).toEqual({ ok: false, reason: 'macros' });

    // A `vbaProject.bin` part is refused even when the content types lie about it.
    expect(
      detectOoxml(docx([{ name: 'word/vbaProject.bin', data: 'vba' }]), 'word')
    ).toEqual({ ok: false, reason: 'macros' });

    const xlsm = contentTypes([
      [
        '/xl/workbook.xml',
        'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
      ],
    ]);
    expect(detectOoxml(xlsx(xlsm), 'excel')).toEqual({
      ok: false,
      reason: 'macros',
    });
  });

  test('embedded objects and ActiveX controls are refused', () => {
    expect(
      detectOoxml(
        docx([{ name: 'word/embeddings/oleObject1.bin', data: 'ole' }]),
        'word'
      )
    ).toEqual({ ok: false, reason: 'embedded' });
    expect(
      detectOoxml(
        docx([{ name: 'word/activeX/activeX1.xml', data: '<ax/>' }]),
        'word'
      )
    ).toEqual({ ok: false, reason: 'embedded' });
    const withOle = contentTypes([
      ['/word/document.xml', WORD_MAIN_CONTENT_TYPE],
      [
        '/word/object1.bin',
        'application/vnd.openxmlformats-officedocument.oleObject',
      ],
    ]);
    expect(detectOoxml(docx([], withOle), 'word')).toEqual({
      ok: false,
      reason: 'embedded',
    });
  });

  test('templates are not documents', () => {
    const dotx = contentTypes([
      [
        '/word/document.xml',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
      ],
    ]);
    expect(detectOoxml(docx([], dotx), 'word')).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  test('a ZIP that is not an OOXML package is refused as a container', () => {
    expect(
      detectOoxml(buildZip([{ name: 'hello.txt', data: 'hi' }]), 'word')
    ).toEqual({ ok: false, reason: 'container' });
    // The signature alone, then garbage.
    expect(
      detectOoxml(
        Buffer.concat([u32(0x04_03_4b_50), Buffer.alloc(40, 7)]),
        'word'
      )
    ).toEqual({ ok: false, reason: 'container' });
    // A ZIP64 end record, which no Office package needs. One entry, so the
    // file still opens with a local header and reaches the directory reader.
    expect(
      detectOoxml(
        buildZip([{ name: 'word/document.xml', data: '<w/>' }], {
          zip64Marker: true,
        }),
        'word'
      )
    ).toEqual({ ok: false, reason: 'container' });
  });

  test('a package with more entries than the cap is refused as a container', () => {
    const many: ZipEntryFixture[] = [
      {
        name: '[Content_Types].xml',
        data: contentTypes([['/word/document.xml', WORD_MAIN_CONTENT_TYPE]]),
      },
    ];
    for (let index = 0; index < OOXML_MAX_ENTRIES; index++)
      many.push({ name: `word/media/${index}.bin`, data: 'x', method: 0 });
    expect(detectOoxml(buildZip(many), 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
  });

  test('not a ZIP at all is a signature refusal', () => {
    expect(detectOoxml(Buffer.from('%PDF-1.4'), 'word')).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(detectOoxml(Buffer.alloc(0), 'excel')).toEqual({
      ok: false,
      reason: 'signature',
    });
  });
});

describe('legacy compound files', () => {
  test('a plain .doc and a plain .xls are admitted, through the mini stream and through ordinary sectors', () => {
    // A 64-byte FIB lives in the mini stream; one padded past the cutoff does not.
    expect(detectCompoundFile(word(), 'word')).toEqual({ ok: true });
    expect(detectCompoundFile(word([], fib(0, 5000)), 'word')).toEqual({
      ok: true,
    });
    expect(detectCompoundFile(excel(), 'excel')).toEqual({ ok: true });
    // The BIFF5 stream name.
    expect(
      detectCompoundFile(
        buildCfb([{ name: 'Book', type: 'stream', data: workbook() }]),
        'excel'
      )
    ).toEqual({ ok: true });
    // Chart and ordinary sheets carry no code.
    expect(
      detectCompoundFile(
        excel([], workbook(boundSheet(0), boundSheet(2))),
        'excel'
      )
    ).toEqual({ ok: true });
  });

  test('the declared family has to match the streams', () => {
    expect(detectCompoundFile(word(), 'excel')).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(detectCompoundFile(excel(), 'word')).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  test('VBA storages are refused, under every name Office uses', () => {
    expect(
      detectCompoundFile(word([{ name: 'Macros', type: 'storage' }]), 'word')
    ).toEqual({ ok: false, reason: 'macros' });
    expect(
      detectCompoundFile(
        excel([{ name: '_VBA_PROJECT_CUR', type: 'storage' }]),
        'excel'
      )
    ).toEqual({ ok: false, reason: 'macros' });
    // Case does not save it.
    expect(
      detectCompoundFile(word([{ name: 'MACROS', type: 'storage' }]), 'word')
    ).toEqual({ ok: false, reason: 'macros' });
  });

  test('an Excel 4.0 macro sheet or a VBA module sheet is code, whatever the storages are called', () => {
    expect(
      detectCompoundFile(
        excel([], workbook(boundSheet(0), boundSheet(0x01))),
        'excel'
      )
    ).toEqual({ ok: false, reason: 'macros' });
    expect(
      detectCompoundFile(excel([], workbook(boundSheet(0x06))), 'excel')
    ).toEqual({ ok: false, reason: 'macros' });
  });

  test('embedded objects are refused', () => {
    expect(
      detectCompoundFile(
        word([{ name: 'ObjectPool', type: 'storage' }]),
        'word'
      )
    ).toEqual({ ok: false, reason: 'embedded' });
    expect(
      detectCompoundFile(
        excel([{ name: 'MBD0001A2B3', type: 'storage' }]),
        'excel'
      )
    ).toEqual({ ok: false, reason: 'embedded' });
  });

  test('an encrypted package cannot be checked and is refused', () => {
    expect(
      detectCompoundFile(
        buildCfb([
          { name: 'EncryptionInfo', type: 'stream' },
          { name: 'EncryptedPackage', type: 'stream' },
        ]),
        'word'
      )
    ).toEqual({ ok: false, reason: 'encrypted' });
  });

  test('legacy encryption is read from the records: the FIB flags and the FilePass record', () => {
    expect(detectCompoundFile(word([], fib(0x01_00)), 'word')).toEqual({
      ok: false,
      reason: 'encrypted',
    });
    expect(detectCompoundFile(word([], fib(0x80_00)), 'word')).toEqual({
      ok: false,
      reason: 'encrypted',
    });
    // Everything after `FilePass` is ciphertext, the macro-sheet record
    // included, so the refusal is for encryption and comes first.
    expect(
      detectCompoundFile(
        excel([], workbook(filePass(), boundSheet(0x01))),
        'excel'
      )
    ).toEqual({ ok: false, reason: 'encrypted' });
  });

  test('the Apache POI encrypted fixtures are refused as encrypted', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixture directory inside this repository
    const names = readdirSync(OFFICE_FIXTURES).filter((name) =>
      /\.(doc|xls)$/i.test(name)
    );
    expect(names).toHaveLength(5);
    for (const name of names) {
      const bytes = new Uint8Array(
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- names come from the directory listing above
        readFileSync(path.join(OFFICE_FIXTURES, name))
      );
      expect(
        detectCompoundFile(bytes, name.endsWith('.doc') ? 'word' : 'excel'),
        name
      ).toEqual({ ok: false, reason: 'encrypted' });
    }
  });

  test('a main stream that is not what its name says is a container refusal', () => {
    expect(
      detectCompoundFile(
        word([], Buffer.from('not a FIB at all, sorry')),
        'word'
      )
    ).toEqual({ ok: false, reason: 'container' });
    expect(
      detectCompoundFile(
        excel([], Buffer.from('no BOF here either!!')),
        'excel'
      )
    ).toEqual({ ok: false, reason: 'container' });
    // An empty main stream has no FIB to read.
    expect(detectCompoundFile(word([], Buffer.alloc(0)), 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
  });

  test('a wrong signature or a truncated file is refused before any walk', () => {
    expect(detectCompoundFile(word().subarray(0, 300), 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
    expect(
      detectCompoundFile(buildCfb([], { badSignature: true }), 'word')
    ).toEqual({ ok: false, reason: 'signature' });
    expect(detectCompoundFile(Buffer.from('PK\u{3}\u{4}'), 'excel')).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  test('a directory chain that loops is refused rather than walked forever', () => {
    const looping = word();
    // Sector 1's FAT entry points back at itself.
    looping.writeUInt32LE(1, SECTOR + 4);
    expect(detectCompoundFile(looping, 'word')).toEqual({
      ok: false,
      reason: 'container',
    });
  });
});
