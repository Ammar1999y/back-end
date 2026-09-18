/**
 * Every `z.preprocess` in the validation layer either leaves an accepted value
 * alone, or publishes a rule the raw value satisfies and says what it does.
 *
 * `z.toJSONSchema` describes what the validator sees AFTER the preprocess, and
 * publishes it as a rule about the raw request. Where the preprocess normalises,
 * the two disagree, and one direction costs real requests: the sanitizers only
 * ever SHORTEN, so a published `minLength` is merely lax (`"a "` passes the
 * document and the server keeps one character), while a published `pattern`
 * refuses input the server accepts outright — a case-sensitive email allowlist
 * for a schema that lowercases, an anchored form for one that trims, a control
 * range for one that folds a line break into a space. Eleven routes carried
 * that, and the fix was per-field — which is what this exists to stop repeating.
 *
 * Both checks are DERIVED, not listed: a leaf is probed with values it accepts,
 * and only one that changes such a value has to describe itself. So a preprocess
 * that merely rejects — the id coercions, which map anything that is not an id
 * to a sentinel the published pattern refuses — needs nothing, and a new
 * normalising leaf fails here on the day it is written.
 */
import { describe, expect, test } from 'bun:test';

import * as z from 'zod';

import * as authSchemas from '@/utils/validation/auth';
import * as mediaSchemas from '@/utils/validation/media';
import * as otpSchemas from '@/utils/validation/otp';
import * as permissionSchemas from '@/utils/validation/permissions';
import * as ruleSchemas from '@/utils/validation/rules';
import * as twoFactorSchemas from '@/utils/validation/two-factor';

const MODULES = {
  auth: authSchemas,
  media: mediaSchemas,
  otp: otpSchemas,
  permissions: permissionSchemas,
  rules: ruleSchemas,
  'two-factor': twoFactorSchemas,
};

/**
 * Inputs a real client sends, in the shapes the sanitizers act on: padded,
 * mixed-case, multi-space, separator-bearing, and compatibility-normalisable.
 * A probe only counts when the schema ACCEPTS it, so one leaf's nonsense is
 * another's ordinary value and the list can stay shared.
 */
const PROBES: readonly unknown[] = [
  ' Aa Bb ',
  'Aa  Bb',
  'Aa\nBb',
  'Aa\tBb',
  'User@Gmail.COM',
  ' User@Gmail.com ',
  ' 123456 ',
  '123456\n',
  // A zero-width space is a FORMAT character, not whitespace: `\\s` does not
  // match it, the sanitizers strip it, and a rich-text copy is where it comes
  // from.
  '12\u{200B}3456',
  'Aa\u{200B}Bb',
  '0512345678',
  '+966 51 234 5678',
  // NFKC folds the fullwidth forms to ASCII, one character for one.
  '\u{FF21}a1!xxxx',
  'Aa1!ﬁxxxxx',
  'My Slug',
  ' 01a02581-a7ee-723b-8000-000000000000 ',
  '01a02581-a7ee-723b-8000-000000000000',
  0,
  null,
  // Not fullwidth, and not one for one: NFKC maps these into the ASCII classes
  // too, and the last two change the LENGTH — a ligature expands, a combining
  // sequence composes. No published class or bound can be true of all four.
  '\u{212A}a1!xxxx',
  '\u{1D400}a1!xxxx',
  'Aa1!\u{FB03}x',
  'Aa1!' + 'e\u{0301}'.repeat(124),
  // At the ceiling AND padded, which is the shape a bound measured on the raw
  // instance refuses: every one of these normalises to exactly its schema's
  // maximum. Generated rather than listed so raising a constant cannot leave
  // the probe behind.
  ...[6, 100, 150, 128].map((max) => ` ${'a'.repeat(max - 1)}b `),
  // The same ceilings reached by COMPOSITION rather than by padding: two raw
  // characters per normalised one, which no `maxLength` and no counting pattern
  // can measure on the instance.
  ...[100, 150].map((max) => 'e\u{0301}'.repeat(max)),
];

type Def = Record<string, unknown>;

function defOf(node: unknown): Def | null {
  if (!node || typeof node !== 'object') return null;
  return (
    ((node as { _zod?: { def?: Def } })._zod?.def as Def | undefined) ?? null
  );
}

/** A description anywhere between the pipe and its leaf counts — wrappers nest. */
function describesItself(node: unknown, depth = 0): boolean {
  const def = defOf(node);
  if (!def || depth > 12) return false;
  if (z.globalRegistry.get(node as z.core.$ZodType)?.description) return true;
  for (const key of ['out', 'innerType', 'element', 'valueType'])
    if (describesItself(def[key], depth + 1)) return true;
  for (const key of ['options', 'items'])
    if (
      Array.isArray(def[key]) &&
      (def[key] as unknown[]).some((entry) => describesItself(entry, depth + 1))
    )
      return true;
  return false;
}

interface Leaf {
  path: string;
  schema: z.core.$ZodType;
  transform: (value: unknown) => unknown;
}

function collect(
  node: unknown,
  path: string,
  into: Leaf[],
  seen: Set<unknown>,
  depth = 0
): void {
  const def = defOf(node);
  if (!def || depth > 12 || seen.has(node)) return;
  seen.add(node);

  if (def.type === 'pipe') {
    const inner = defOf(def.in);
    if (inner?.type === 'transform') {
      into.push({
        path,
        schema: node as z.core.$ZodType,
        transform: inner.transform as (value: unknown) => unknown,
      });
      collect(def.out, path, into, seen, depth + 1);
      return;
    }
  }

  if (def.type === 'object' && def.shape)
    for (const [key, value] of Object.entries(def.shape as Def))
      collect(value, `${path}.${key}`, into, seen, depth + 1);
  for (const key of ['in', 'out', 'innerType', 'element', 'valueType'])
    collect(def[key], path, into, seen, depth + 1);
  for (const key of ['options', 'items']) {
    const branches = def[key];
    if (!Array.isArray(branches)) continue;
    for (const [index, entry] of branches.entries())
      collect(entry, `${path}[${index}]`, into, seen, depth + 1);
  }
}

const leaves: Leaf[] = [];
const seen = new Set<unknown>();
for (const [moduleName, module] of Object.entries(MODULES))
  for (const [exportName, value] of Object.entries(module))
    collect(value, `${moduleName}.${exportName}`, leaves, seen);

describe('a preprocess that rewrites accepted input publishes what it does', () => {
  test('the walk reaches the layer, so nothing below passes vacuously', () => {
    // The whole file is a loop over what this finds; an empty or shallow walk
    // would be a silent pass. The count is a floor, not an inventory.
    expect(leaves.length).toBeGreaterThanOrEqual(10);
    expect(leaves.map((leaf) => leaf.path)).toContain(
      'auth.adminUpdateUserBodySchema.email'
    );
  });

  test.each(leaves.map((leaf): [string, Leaf] => [leaf.path, leaf]))(
    '%s',
    (_path, leaf) => {
      const rewritten = PROBES.filter((probe) => {
        if (!leaf.schema['~standard'].validate) return false;
        const parsed = z.safeParse(leaf.schema, probe);
        if (!parsed.success) return false;
        let normalised: unknown;
        try {
          normalised = leaf.transform(probe);
        } catch {
          return false;
        }
        return normalised !== probe;
      });

      // Either it left every value it accepts alone, or it says so in the
      // document. The probe list is what decides which; extend it before
      // adding an exception here.
      expect([
        leaf.path,
        rewritten.length > 0 && !describesItself(leaf.schema),
      ]).toEqual([leaf.path, false]);
    }
  );
});

/**
 * What a format-checking validator asserts, spelled out because this file cannot
 * import one: Ajv is present only as a transitive dependency, and an undeclared
 * import is a phantom dependency the unused-files gate refuses. `format` is an
 * annotation until a consumer turns assertion on — which is Ajv's default — so a
 * format on a request leaf still has to be true of what the server accepts.
 *
 * Deliberately LAXER than any real implementation of these formats: an
 * approximation that refused more would report divergences that no consumer has,
 * where one that refuses less can only under-report. What it does catch is the
 * whole reason a normalising leaf breaks a format — surrounding whitespace, and
 * characters the sanitizers remove.
 */
const FORMAT_ASSERTIONS: Readonly<Record<string, RegExp>> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f-]+$/i,
};

/**
 * Every keyword a string can fail, read off the emitted schema.
 *
 * All of them, including the length bounds and `format`: a keyword that is only
 * true of the normalised value is a keyword that refuses a request the server
 * would have answered, and which of them does it is not a distinction a
 * generated client makes.
 */
function publishedRefuses(emitted: Record<string, unknown>, value: string) {
  const branches = Array.isArray(emitted.allOf) ? emitted.allOf : [];
  const patterns = [emitted, ...branches]
    .map((node) => (node as Record<string, unknown>).pattern)
    .filter((pattern) => typeof pattern === 'string');
  for (const pattern of patterns)
    // eslint-disable-next-line security/detect-non-literal-regexp -- the schema's own published pattern, which is exactly what a generated client compiles
    if (!new RegExp(pattern).test(value)) return `pattern ${pattern}`;
  const format = emitted.format;
  if (typeof format === 'string') {
    const asserts = FORMAT_ASSERTIONS[format];
    if (!asserts)
      return `format ${format} (no assertion declared for it in this test)`;
    if (!asserts.test(value)) return `format ${format}`;
  }
  if (typeof emitted.minLength === 'number' && value.length < emitted.minLength)
    return `minLength ${emitted.minLength}`;
  if (typeof emitted.maxLength === 'number' && value.length > emitted.maxLength)
    return `maxLength ${emitted.maxLength}`;
  return null;
}

describe('the published rule admits the raw value the server accepts', () => {
  test.each(leaves.map((leaf): [string, Leaf] => [leaf.path, leaf]))(
    '%s',
    (_path, leaf) => {
      const emitted = z.toJSONSchema(leaf.schema, {
        io: 'input',
        unrepresentable: 'any',
      }) as Record<string, unknown>;

      const refused = PROBES.filter(
        (probe) =>
          typeof probe === 'string' &&
          z.safeParse(leaf.schema, probe).success &&
          publishedRefuses(emitted, probe) !== null
      ).map((probe) => [probe, publishedRefuses(emitted, probe as string)]);

      // A generated client applies these keywords before the request is sent,
      // so anything listed here is a call the server would have answered 200
      // and the client never made.
      expect([leaf.path, refused]).toEqual([leaf.path, []]);
    }
  );
});
