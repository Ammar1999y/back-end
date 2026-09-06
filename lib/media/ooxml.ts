/**
 * Office Open XML inspection — `.docx` and `.xlsx` are ZIP packages, and a ZIP
 * signature alone proves nothing about what is inside.
 *
 * The package's `[Content_Types].xml` names the content type of every part;
 * the MAIN part's type is what distinguishes a document from a spreadsheet, a
 * template, or a macro-enabled variant. Macro-enabled packages
 * (`.docm`/`.xlsm`) declare `…macroEnabled…` types and carry a
 * `vbaProject.bin` part; embedded OLE objects and ActiveX controls live under
 * `embeddings/` and `activeX/`. All of those are refused: they are the payload
 * carriers, and a dashboard has no use for them.
 *
 * Own reader rather than a library. The whole job is the central directory
 * plus ONE inflated entry, and a general-purpose unzipper would inflate on
 * demand what this deliberately never touches. The content-types part is read
 * with a small XML tokenizer rather than a pattern match: an XML parser resolves
 * `&#80;`, so a pattern that did not was bypassed by it (reproduced); a full
 * parser would add a dependency to read a file that is a flat list of two
 * element kinds. Whatever Office never writes — a DOCTYPE, an entity this
 * tokenizer does not know, a duplicate part, a local header that disagrees with
 * the central directory — makes the package unreadable rather than partly read,
 * because every one of those is also how two readers come to disagree.
 */
import { inflateRawSync } from 'node:zlib';
import type { DetectResult } from './detect-result';

const LOCAL_FILE_HEADER = 0x04_03_4b_50;
const CENTRAL_DIRECTORY_HEADER = 0x02_01_4b_50;
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;

/** EOCD is 22 bytes plus a comment of at most 65 535. */
const EOCD_MIN_SIZE = 22;
const EOCD_SCAN_WINDOW = EOCD_MIN_SIZE + 0xff_ff;

/** Bounds the central-directory walk; a real package has a few dozen parts. */
export const OOXML_MAX_ENTRIES = 2000;
/** `[Content_Types].xml` is a few KB; this is a zip-bomb guard, not a budget. */
const CONTENT_TYPES_MAX_BYTES = 1024 * 1024;

const CONTENT_TYPES_PART = '[content_types].xml';

export const WORD_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
export const EXCEL_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

export type OoxmlFamily = 'word' | 'excel';

const MAIN_CONTENT_TYPE: Record<OoxmlFamily, string> = {
  word: WORD_MAIN_CONTENT_TYPE,
  excel: EXCEL_MAIN_CONTENT_TYPE,
};

/** Parts that carry executable or foreign content, by path. */
const PAYLOAD_PART = /(^|\/)(vbaproject\.bin|embeddings\/|activex\/)/;

/** Content types that carry executable or foreign content. */
const PAYLOAD_CONTENT_TYPE =
  /macroenabled|application\/vnd\.openxmlformats-officedocument\.oleobject|application\/vnd\.ms-office\.activex|application\/vnd\.ms-office\.vbaproject/;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const utf8 = new TextDecoder('utf-8');

/**
 * The central directory, or `null` for anything that is not a plain ZIP —
 * including one that names a part twice, which is a package two extractors
 * can read differently.
 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] | null {
  if (bytes.length < EOCD_MIN_SIZE) return null;
  const data = view(bytes);

  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_SCAN_WINDOW);
  for (let offset = bytes.length - EOCD_MIN_SIZE; offset >= lowest; offset--) {
    if (data.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) return null;

  const total = data.getUint16(eocd + 10, true);
  const directorySize = data.getUint32(eocd + 12, true);
  const directoryOffset = data.getUint32(eocd + 16, true);
  // ZIP64 markers. No Office document needs them; refusing keeps the reader
  // to one format.
  if (
    total === 0xff_ff ||
    directoryOffset === 0xff_ff_ff_ff ||
    directorySize === 0xff_ff_ff_ff
  )
    return null;
  if (total > OOXML_MAX_ENTRIES) return null;
  if (directoryOffset + directorySize > eocd) return null;

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let offset = directoryOffset;
  for (let index = 0; index < total; index++) {
    if (offset + 46 > bytes.length) return null;
    if (data.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER) return null;
    const method = data.getUint16(offset + 10, true);
    const compressedSize = data.getUint32(offset + 20, true);
    const uncompressedSize = data.getUint32(offset + 24, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localHeaderOffset = data.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    if (nameStart + nameLength > bytes.length) return null;
    const name = utf8.decode(bytes.subarray(nameStart, nameStart + nameLength));
    // Part names are case-insensitive in OPC, so two spellings are one part.
    const lower = name.toLowerCase();
    if (seen.has(lower)) return null;
    seen.add(lower);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Where one entry's data begins, or `null` when its local header is missing or
 * names a different file than the central directory does — an extractor that
 * trusts one and a reader that trusts the other would open different parts, so
 * every admitted entry is checked, not only the one that is inflated. A header
 * read, never an inflate, so the cost stays inside the entry cap.
 */
function localDataStart(bytes: Uint8Array, entry: ZipEntry): number | null {
  const data = view(bytes);
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.length) return null;
  if (data.getUint32(header, true) !== LOCAL_FILE_HEADER) return null;
  const nameLength = data.getUint16(header + 26, true);
  const extraLength = data.getUint16(header + 28, true);
  const nameStart = header + 30;
  if (nameStart + nameLength > bytes.length) return null;
  if (
    utf8.decode(bytes.subarray(nameStart, nameStart + nameLength)) !==
    entry.name
  )
    return null;
  return nameStart + nameLength + extraLength;
}

/**
 * One entry's bytes, or `null` when it cannot be read within the caps. Only
 * `stored` and `deflate` are handled — the two methods Office writes.
 */
function readEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  if (entry.uncompressedSize > CONTENT_TYPES_MAX_BYTES) return null;
  const start = localDataStart(bytes, entry);
  if (start === null) return null;
  const end = start + entry.compressedSize;
  if (end > bytes.length) return null;
  const compressed = bytes.subarray(start, end);

  if (entry.method === 0) return compressed;
  if (entry.method !== 8) return null;
  try {
    const inflated = inflateRawSync(compressed, {
      maxOutputLength: CONTENT_TYPES_MAX_BYTES,
    });
    return inflated.length > CONTENT_TYPES_MAX_BYTES ? null : inflated;
  } catch {
    return null;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/**
 * XML's `Char` production: what a character reference is allowed to denote. A
 * conforming parser makes anything else a fatal error, so resolving one here
 * would be this reader disagreeing with the one Office uses — and
 * `String.fromCodePoint` throws above the Unicode range, which turned hostile
 * bytes into a 500 before the check was two-sided.
 */
const XML_WHITESPACE = new Set([0x9, 0xa, 0xd]);

function isXmlChar(codePoint: number): boolean {
  if (XML_WHITESPACE.has(codePoint)) return true;
  if (codePoint < 0x20) return false;
  if (codePoint <= 0xd7_ff) return true;
  if (codePoint < 0xe0_00) return false;
  if (codePoint <= 0xff_fd) return true;
  return codePoint >= 0x1_00_00 && codePoint <= 0x10_ff_ff;
}

/**
 * An attribute value as XML would deliver it: the five predefined entities and
 * numeric character references resolved. Any other reference — a DTD-defined
 * entity, a malformed one, one outside `Char` — is `null`: Office writes none,
 * and an unresolved one is how a value hides from a comparison.
 */
function decodeAttributeValue(raw: string): string | null {
  let out = '';
  let index = 0;
  while (index < raw.length) {
    const ampersand = raw.indexOf('&', index);
    if (ampersand === -1) {
      out += raw.slice(index);
      break;
    }
    out += raw.slice(index, ampersand);
    const semicolon = raw.indexOf(';', ampersand);
    if (semicolon === -1) return null;
    const reference = raw.slice(ampersand + 1, semicolon);
    if (reference.startsWith('#x') || reference.startsWith('#X')) {
      if (!/^#[xX][0-9A-Fa-f]{1,6}$/.test(reference)) return null;
      const codePoint = Number.parseInt(reference.slice(2), 16);
      if (!isXmlChar(codePoint)) return null;
      out += String.fromCodePoint(codePoint);
    } else if (reference.startsWith('#')) {
      if (!/^#\d{1,7}$/.test(reference)) return null;
      const codePoint = Number(reference.slice(1));
      if (!isXmlChar(codePoint)) return null;
      out += String.fromCodePoint(codePoint);
    } else {
      const named = NAMED_ENTITIES[reference];
      if (named === undefined) return null;
      out += named;
    }
    index = semicolon + 1;
  }
  // Attribute-value normalisation folds the XML whitespace characters to spaces.
  return out.replaceAll(/[\t\n\r]/g, ' ');
}

interface ContentTypeElement {
  /** `Default` or `Override`, without any namespace prefix. */
  kind: string;
  attributes: Map<string, string>;
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[\w.:-]/;

function skipSpaces(xml: string, cursor: number): number {
  let at = cursor;
  while (at < xml.length && /\s/.test(xml[at] ?? '')) at += 1;
  return at;
}

function readName(
  xml: string,
  cursor: number
): { name: string; end: number } | null {
  let at = cursor;
  while (at < xml.length && NAME_CHAR.test(xml[at] ?? '')) at += 1;
  const name = xml.slice(cursor, at);
  if (name === '' || !NAME_START.test(name[0] ?? '')) return null;
  return { name, end: at };
}

const localPart = (qualified: string) =>
  qualified.slice(qualified.lastIndexOf(':') + 1);

/**
 * Attribute names are kept QUALIFIED, and a prefixed one that is not a
 * namespace declaration makes the package unreadable.
 *
 * `x:ContentType` and `ContentType` are two attributes under the namespace
 * rules, so folding them to their local part let the second overwrite the first
 * and the manifest declare a VBA type this reader never saw (reproduced). The
 * manifest grammar has no prefixed attributes at all, so refusing one costs
 * nothing and models what is left exactly.
 */
const isSupportedAttributeName = (name: string) =>
  !name.includes(':') || name.startsWith('xmlns:');

/** One start tag from just after its `<`: local name, decoded attributes, and where it ends. */
function readStartTag(
  xml: string,
  start: number
): (ContentTypeElement & { end: number }) | null {
  const element = readName(xml, start);
  if (!element) return null;
  const kind = localPart(element.name);
  const attributes = new Map<string, string>();
  let cursor = element.end;
  for (;;) {
    cursor = skipSpaces(xml, cursor);
    if (cursor >= xml.length) return null;
    if (xml.startsWith('/>', cursor))
      return { kind, attributes, end: cursor + 2 };
    if (xml[cursor] === '>') return { kind, attributes, end: cursor + 1 };
    const attribute = readName(xml, cursor);
    if (!attribute) return null;
    // A repeated name is a fatal error in XML, not a last-one-wins.
    if (
      !isSupportedAttributeName(attribute.name) ||
      attributes.has(attribute.name)
    )
      return null;
    cursor = skipSpaces(xml, attribute.end);
    if (xml[cursor] !== '=') return null;
    cursor = skipSpaces(xml, cursor + 1);
    const quote = xml[cursor];
    if (quote !== '"' && quote !== "'") return null;
    const valueEnd = xml.indexOf(quote, cursor + 1);
    if (valueEnd === -1) return null;
    const raw = xml.slice(cursor + 1, valueEnd);
    if (raw.includes('<')) return null;
    const value = decodeAttributeValue(raw);
    if (value === null) return null;
    attributes.set(attribute.name, value);
    cursor = valueEnd + 1;
  }
}

/**
 * The elements of `[Content_Types].xml`, attributes decoded. `null` for
 * anything that is not the flat, prolog-plus-elements XML Office writes: a
 * DOCTYPE (external entities, and Office never emits one), a CDATA section, an
 * unterminated construct, an attribute without quotes, a stray `<`.
 */
function readElements(xml: string): ContentTypeElement[] | null {
  const elements: ContentTypeElement[] = [];
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open === -1) break;
    if (xml.startsWith('<?', open)) {
      const close = xml.indexOf('?>', open);
      if (close === -1) return null;
      index = close + 2;
      continue;
    }
    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open);
      if (close === -1) return null;
      index = close + 3;
      continue;
    }
    if (xml.startsWith('<!', open)) return null;
    if (xml.startsWith('</', open)) {
      const close = xml.indexOf('>', open);
      if (close === -1) return null;
      index = close + 1;
      continue;
    }

    const tag = readStartTag(xml, open + 1);
    if (!tag) return null;
    elements.push({ kind: tag.kind, attributes: tag.attributes });
    index = tag.end;
  }
  return elements;
}

/**
 * Is this a plain OOXML package of `family`, free of macros, embedded objects
 * and ActiveX?
 */
export function detectOoxml(
  bytes: Uint8Array,
  family: OoxmlFamily
): DetectResult {
  if (bytes.length < 4 || view(bytes).getUint32(0, true) !== LOCAL_FILE_HEADER)
    return { ok: false, reason: 'signature' };

  const entries = readCentralDirectory(bytes);
  if (!entries) return { ok: false, reason: 'container' };

  const partNames = new Set<string>();
  let contentTypesEntry: ZipEntry | null = null;
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (PAYLOAD_PART.test(lower))
      return {
        ok: false,
        reason: lower.includes('vbaproject') ? 'macros' : 'embedded',
      };
    if (localDataStart(bytes, entry) === null)
      return { ok: false, reason: 'container' };
    partNames.add(lower);
    if (lower === CONTENT_TYPES_PART) contentTypesEntry = entry;
  }
  if (!contentTypesEntry) return { ok: false, reason: 'container' };

  const xmlBytes = readEntry(bytes, contentTypesEntry);
  if (!xmlBytes) return { ok: false, reason: 'container' };
  const elements = readElements(utf8.decode(xmlBytes));
  if (!elements) return { ok: false, reason: 'container' };

  let mainPart: string | null = null;
  for (const element of elements) {
    if (element.kind !== 'Default' && element.kind !== 'Override') continue;
    const type = element.attributes.get('ContentType')?.trim().toLowerCase();
    if (!type) continue;
    if (PAYLOAD_CONTENT_TYPE.test(type))
      return {
        ok: false,
        reason:
          type.includes('macro') || type.includes('vbaproject')
            ? 'macros'
            : 'embedded',
      };
    if (element.kind === 'Override' && type === MAIN_CONTENT_TYPE[family])
      mainPart = element.attributes.get('PartName')?.trim() ?? null;
  }

  // The main part has to be declared AND present; a declaration alone is a
  // string in a manifest, not a document.
  if (mainPart === null) return { ok: false, reason: 'mismatch' };
  return partNames.has(mainPart.replace(/^\//, '').toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'container' };
}
