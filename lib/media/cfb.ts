/**
 * Compound File Binary inspection — the container behind legacy `.doc` and
 * `.xls`, and behind every password-protected Office file of any age.
 *
 * A compound file is a small filesystem: a FAT of sectors, a mini FAT for the
 * small streams packed into the root entry's stream, and a directory of named
 * storages and streams. Two levels are inspected, because names answer only
 * part of the question:
 *
 * - Directory names. Word keeps macros under a `Macros` storage, Excel under
 *   `_VBA_PROJECT_CUR`; embedded objects sit in `ObjectPool` (Word) or `MBD…`
 *   storages (Excel); an ECMA-376 encrypted package carries `EncryptedPackage`
 *   and `EncryptionInfo`.
 * - Records. Legacy encryption is NOT a directory entry. Word records it in the
 *   `fEncrypted`/`fObfuscated` bits of the FIB at the head of `WordDocument`
 *   ([MS-DOC] 2.5.2); Excel writes a `FilePass` record into the `Workbook`
 *   stream ([MS-XLS] 2.4.117), after which every record is ciphertext —
 *   including the `BoundSheet8` records ([MS-XLS] 2.4.28) whose `dt` names an
 *   Excel 4.0 macro sheet or a VBA module, neither of which a storage name
 *   reveals. Both were measured against Apache POI's encrypted fixtures
 *   (`tests/fixtures/office`): every one passed the name check and none pass
 *   the record check.
 *
 * What this does not read: field codes, DDE links, external references. Those
 * are content, and the documents are served as attachments and never rendered
 * here; the contract states it (`UPLOAD_LIMITS_DESCRIPTION`).
 *
 * Reference: [MS-CFB] 2.2 (header), 2.3 (FAT), 2.4 (mini FAT), 2.5 (DIFAT),
 * 2.6 (directory entry). Only what the two levels need is read.
 */
import type { DetectResult } from './detect-result';

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

const END_OF_CHAIN = 0xff_ff_ff_fe;
const FREE_SECTOR = 0xff_ff_ff_ff;
/** The header's own DIFAT holds this many FAT sector numbers. */
const HEADER_DIFAT_ENTRIES = 109;
const DIRECTORY_ENTRY_SIZE = 128;

/** Bounds the walks. The largest legitimate directories are a few hundred entries. */
const CFB_MAX_DIRECTORY_ENTRIES = 4096;
const MAX_FAT_SECTORS = 4096;
const MAX_DIFAT_SECTORS = 64;
const MAX_MINI_FAT_SECTORS = 4096;
/** The FIB base is 32 bytes; nothing past it is read for Word. */
const FIB_BASE_SIZE = 32;
/** BIFF records walked before the globals substream is declared malformed. */
const BIFF_MAX_RECORDS = 200_000;

export type CompoundFamily = 'word' | 'excel';

/** Storage names (lowercased) under which VBA lives, per Office application. */
const MACRO_STORAGES = new Set([
  'macros',
  '_vba_project_cur',
  'vba',
  '_vba_project',
]);
const ENCRYPTION_STREAMS = new Set(['encryptedpackage', 'encryptioninfo']);
const REQUIRED_STREAM: Record<CompoundFamily, ReadonlySet<string>> = {
  word: new Set(['worddocument']),
  excel: new Set(['workbook', 'book']),
};

/** [MS-DOC] 2.5.2 FibBase: `wIdent` at 0, the flag word at 10. */
const FIB_MAGIC = 0xa5_ec;
const FIB_ENCRYPTED = 0x01_00;
const FIB_OBFUSCATED = 0x80_00;

/** [MS-XLS] record types. */
const BIFF_BOF = 0x08_09;
const BIFF_EOF = 0x00_0a;
const BIFF_FILE_PASS = 0x00_2f;
const BIFF_BOUND_SHEET = 0x00_85;
/** `BoundSheet8.dt`: 0x01 an Excel 4.0 macro sheet, 0x06 a VBA module. */
const SHEET_TYPES_WITH_CODE = new Set([0x01, 0x06]);

type EntryType = 'storage' | 'stream' | 'root';

interface DirectoryEntry {
  name: string;
  type: EntryType;
  startSector: number;
  size: number;
}

/** What every reader below needs about the file: its bytes and its sector geometry. */
interface Layout {
  bytes: Uint8Array;
  data: DataView;
  sectorSize: number;
  entriesPerFatSector: number;
  miniSectorSize: number;
  miniStreamCutoff: number;
}

interface Parsed {
  layout: Layout;
  fat: readonly number[];
  entries: readonly DirectoryEntry[];
}

function hasSignature(bytes: Uint8Array): boolean {
  return SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function sectorOffset(layout: Layout, sector: number): number {
  return (sector + 1) * layout.sectorSize;
}

function sectorInFile(layout: Layout, sector: number): boolean {
  return (
    sector < FREE_SECTOR - 1 &&
    sectorOffset(layout, sector) + layout.sectorSize <= layout.bytes.length
  );
}

/** `count` sector numbers from `base`, stopping at the first free slot. */
function sectorNumbersAt(
  layout: Layout,
  base: number,
  count: number
): number[] {
  const sectors: number[] = [];
  for (let index = 0; index < count; index++) {
    const sector = layout.data.getUint32(base + index * 4, true);
    if (sector === FREE_SECTOR) break;
    sectors.push(sector);
  }
  return sectors;
}

/**
 * The FAT sector numbers: 109 in the header, the rest chained through DIFAT
 * sectors whose last slot points at the next DIFAT sector.
 */
function fatSectorNumbers(layout: Layout): number[] | null {
  const { data } = layout;
  const difatSectorCount = data.getUint32(72, true);
  if (difatSectorCount > MAX_DIFAT_SECTORS) return null;

  const fatSectors = sectorNumbersAt(layout, 76, HEADER_DIFAT_ENTRIES);
  let difatSector = data.getUint32(68, true);
  let walked = 0;
  while (difatSector !== END_OF_CHAIN && walked < difatSectorCount) {
    if (!sectorInFile(layout, difatSector)) return null;
    const base = sectorOffset(layout, difatSector);
    fatSectors.push(
      ...sectorNumbersAt(layout, base, layout.entriesPerFatSector - 1)
    );
    difatSector = data.getUint32(
      base + (layout.entriesPerFatSector - 1) * 4,
      true
    );
    walked += 1;
  }
  return fatSectors.length > MAX_FAT_SECTORS ? null : fatSectors;
}

/** A flat table of u32 entries read from `sectors`, or `null` when one lies outside the file. */
function readTable(
  layout: Layout,
  sectors: readonly number[]
): number[] | null {
  const table: number[] = [];
  for (const sector of sectors) {
    if (!sectorInFile(layout, sector)) return null;
    const base = sectorOffset(layout, sector);
    for (let index = 0; index < layout.entriesPerFatSector; index++)
      table.push(layout.data.getUint32(base + index * 4, true));
  }
  return table;
}

/** The sectors of one chain, in order; `null` on a loop, a walk off the file, or past `maxSectors`. */
function readChain(
  layout: Layout,
  fat: readonly number[],
  firstSector: number,
  maxSectors: number
): number[] | null {
  const chain: number[] = [];
  const visited = new Set<number>();
  let sector = firstSector;
  while (sector !== END_OF_CHAIN) {
    if (visited.has(sector) || !sectorInFile(layout, sector)) return null;
    if (chain.length >= maxSectors) return null;
    visited.add(sector);
    chain.push(sector);
    const next = fat[sector];
    if (next === undefined) return null;
    sector = next;
  }
  return chain;
}

/** One 128-byte directory entry, or `null` for an unused slot. */
function directoryEntryAt(
  layout: Layout,
  offset: number
): DirectoryEntry | null {
  const typeByte = layout.bytes[offset + 66];
  const type: EntryType | null =
    typeByte === 1
      ? 'storage'
      : typeByte === 2
        ? 'stream'
        : typeByte === 5
          ? 'root'
          : null;
  if (type === null) return null;
  const nameBytes = Math.min(layout.data.getUint16(offset + 64, true), 64);
  // UTF-16LE including the terminator, which the length counts.
  const name = new TextDecoder('utf-16le').decode(
    layout.bytes.subarray(offset, offset + Math.max(0, nameBytes - 2))
  );
  return {
    name,
    type,
    startSector: layout.data.getUint32(offset + 116, true),
    // The high half is reserved in version 3 files and unused by Office either
    // way; a stream larger than the file cannot be read regardless.
    size: layout.data.getUint32(offset + 120, true),
  };
}

/** The directory chain, sector by sector, refusing a loop or a walk off the file. */
function readDirectory(
  layout: Layout,
  fat: readonly number[],
  firstSector: number
): DirectoryEntry[] | null {
  const chain = readChain(
    layout,
    fat,
    firstSector,
    Math.ceil(
      (CFB_MAX_DIRECTORY_ENTRIES * DIRECTORY_ENTRY_SIZE) / layout.sectorSize
    ) + 1
  );
  if (!chain) return null;
  const entries: DirectoryEntry[] = [];
  for (const sector of chain) {
    const base = sectorOffset(layout, sector);
    for (
      let position = 0;
      position + DIRECTORY_ENTRY_SIZE <= layout.sectorSize;
      position += DIRECTORY_ENTRY_SIZE
    ) {
      const entry = directoryEntryAt(layout, base + position);
      if (entry) entries.push(entry);
      if (entries.length > CFB_MAX_DIRECTORY_ENTRIES) return null;
    }
  }
  return entries;
}

/** Header, FAT and directory, or `null` when the structure cannot be walked within the caps. */
function parse(bytes: Uint8Array): Parsed | null {
  if (bytes.length < 512) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sectorShift = data.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) return null;
  const miniSectorShift = data.getUint16(32, true);
  if (miniSectorShift !== 6) return null;
  const sectorSize = 1 << sectorShift;
  const layout: Layout = {
    bytes,
    data,
    sectorSize,
    entriesPerFatSector: sectorSize / 4,
    miniSectorSize: 1 << miniSectorShift,
    miniStreamCutoff: data.getUint32(56, true),
  };
  if (data.getUint32(44, true) > MAX_FAT_SECTORS) return null;

  const fatSectors = fatSectorNumbers(layout);
  if (!fatSectors) return null;
  const fat = readTable(layout, fatSectors);
  if (!fat) return null;
  const entries = readDirectory(layout, fat, data.getUint32(48, true));
  if (!entries) return null;
  return { layout, fat, entries };
}

/**
 * The first `limit` bytes of a stream (all of it when `limit` is larger).
 * A stream under the cutoff lives in the mini stream — the root entry's own
 * chain, cut into 64-byte mini sectors and chained through the mini FAT — and
 * anything else in ordinary sectors. `null` when the chains do not deliver the
 * bytes the entry claims.
 */
function readStream(
  parsed: Parsed,
  entry: DirectoryEntry,
  limit: number
): Uint8Array | null {
  const { layout, fat } = parsed;
  const size = Math.min(entry.size, limit);
  const out = new Uint8Array(size);
  if (size === 0) return out;

  if (entry.size < layout.miniStreamCutoff) {
    const root = parsed.entries[0];
    if (!root || root.type !== 'root') return null;
    const miniFatCount = layout.data.getUint32(64, true);
    if (miniFatCount > MAX_MINI_FAT_SECTORS) return null;
    const miniFatSectors = readChain(
      layout,
      fat,
      layout.data.getUint32(60, true),
      miniFatCount
    );
    if (!miniFatSectors) return null;
    const miniFat = readTable(layout, miniFatSectors);
    const miniStream = readChain(
      layout,
      fat,
      root.startSector,
      Math.ceil(layout.bytes.length / layout.sectorSize)
    );
    if (!miniFat || !miniStream) return null;

    const perSector = layout.sectorSize / layout.miniSectorSize;
    const visited = new Set<number>();
    let mini = entry.startSector;
    let written = 0;
    while (written < size) {
      if (mini === END_OF_CHAIN || visited.has(mini) || mini >= miniFat.length)
        return null;
      visited.add(mini);
      const sector = miniStream[Math.floor(mini / perSector)];
      if (sector === undefined) return null;
      const start =
        sectorOffset(layout, sector) +
        (mini % perSector) * layout.miniSectorSize;
      const take = Math.min(layout.miniSectorSize, size - written);
      out.set(layout.bytes.subarray(start, start + take), written);
      written += take;
      const next = miniFat[mini];
      if (next === undefined) return null;
      mini = next;
    }
    return out;
  }

  const visited = new Set<number>();
  let sector = entry.startSector;
  let written = 0;
  while (written < size) {
    if (visited.has(sector) || !sectorInFile(layout, sector)) return null;
    visited.add(sector);
    const start = sectorOffset(layout, sector);
    const take = Math.min(layout.sectorSize, size - written);
    out.set(layout.bytes.subarray(start, start + take), written);
    written += take;
    const next = fat[sector];
    if (next === undefined) return null;
    sector = next;
  }
  return out;
}

/** The FIB base at the head of `WordDocument`. */
function inspectWord(fib: Uint8Array): DetectResult {
  if (fib.length < 12) return { ok: false, reason: 'container' };
  const data = new DataView(fib.buffer, fib.byteOffset, fib.byteLength);
  if (data.getUint16(0, true) !== FIB_MAGIC)
    return { ok: false, reason: 'container' };
  const flags = data.getUint16(10, true);
  if ((flags & FIB_ENCRYPTED) !== 0 || (flags & FIB_OBFUSCATED) !== 0)
    return { ok: false, reason: 'encrypted' };
  return { ok: true };
}

/**
 * The workbook globals substream: `BOF` … `EOF`. A `FilePass` anywhere in it
 * means everything after is ciphertext, so it is refused before any sheet record
 * is trusted; a `BoundSheet8` whose `dt` names a macro sheet or a VBA module is
 * code however the storages are named.
 */
function inspectWorkbook(stream: Uint8Array): DetectResult {
  if (stream.length < 4) return { ok: false, reason: 'container' };
  const data = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength
  );
  if (data.getUint16(0, true) !== BIFF_BOF)
    return { ok: false, reason: 'container' };

  let position = 0;
  for (let records = 0; records < BIFF_MAX_RECORDS; records++) {
    if (position + 4 > stream.length) return { ok: false, reason: 'container' };
    const type = data.getUint16(position, true);
    if (type === BIFF_FILE_PASS) return { ok: false, reason: 'encrypted' };
    if (type === BIFF_EOF) return { ok: true };
    const size = data.getUint16(position + 2, true);
    const body = position + 4;
    if (type === BIFF_BOUND_SHEET && size >= 6 && body + 6 <= stream.length) {
      const sheetType = stream[body + 5] ?? 0;
      if (SHEET_TYPES_WITH_CODE.has(sheetType))
        return { ok: false, reason: 'macros' };
    }
    position = body + size;
  }
  return { ok: false, reason: 'container' };
}

/**
 * Is this a plain legacy Office file of `family`, free of macros, embedded
 * objects and encryption?
 *
 * Names are compared lowercased and without their leading control character
 * (`\x05SummaryInformation`, `\x01CompObj`): the character is a sort-order
 * convention, not part of the name a check should key on.
 */
export function detectCompoundFile(
  bytes: Uint8Array,
  family: CompoundFamily
): DetectResult {
  if (!hasSignature(bytes)) return { ok: false, reason: 'signature' };
  const parsed = parse(bytes);
  if (!parsed) return { ok: false, reason: 'container' };

  const plainName = (entry: DirectoryEntry) => {
    const first = entry.name.codePointAt(0) ?? 0x20;
    return (first < 0x20 ? entry.name.slice(1) : entry.name).toLowerCase();
  };

  for (const entry of parsed.entries) {
    const name = plainName(entry);
    if (ENCRYPTION_STREAMS.has(name)) return { ok: false, reason: 'encrypted' };
    if (MACRO_STORAGES.has(name)) return { ok: false, reason: 'macros' };
    if (name === 'objectpool' || name.startsWith('mbd'))
      return { ok: false, reason: 'embedded' };
  }

  const required = REQUIRED_STREAM[family];
  const main = parsed.entries.find(
    (entry) => entry.type === 'stream' && required.has(plainName(entry))
  );
  if (!main) return { ok: false, reason: 'mismatch' };

  const stream = readStream(
    parsed,
    main,
    family === 'word' ? FIB_BASE_SIZE : main.size
  );
  if (!stream) return { ok: false, reason: 'container' };
  return family === 'word' ? inspectWord(stream) : inspectWorkbook(stream);
}
