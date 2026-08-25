/**
 * How a request's client IP is resolved, and how it is turned into a rate-limit
 * key: `getClientIp`/`TRUSTED_IP_HEADERS` in `lib/audit.ts`, and `ipBucket` via
 * `ipIdentifier` in `lib/rate-limit/api.ts`.
 *
 * Neither had an assertion anywhere under `tests/` before this file, and between
 * them they decide three things: whether a forged header can choose whose budget
 * a request spends, whether a missing edge header fails open or closed, and how
 * many budgets one IPv6 host can reach.
 *
 * `ipBucket` is not exported, so every bucketing assertion runs through
 * `ipIdentifier` — which is the honest path anyway: an input only reaches the
 * bucket after `getClientIp`'s validator has accepted it, and several inputs the
 * brief expected to see bucketed never get that far.
 *
 * Two behaviours below are PINNED DEFECTS, named as such at their tests: the
 * bucket keys the SPELLING of an address rather than the address, so one host
 * can hold several budgets. They are pinned rather than left failing because the
 * fix belongs to `lib/rate-limit/api.ts`, which this file does not own.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';

import { getClientIp, TRUSTED_IP_HEADERS } from '@/lib/audit';
import { ipIdentifier, userIdentifier } from '@/lib/rate-limit/api';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

const TRUSTED_HEADER = TRUSTED_IP_HEADERS[0];

const header = (value: string, name: string = TRUSTED_HEADER) =>
  new Headers({ [name]: value });

/** The full path an inbound request takes: header -> validator -> bucket key. */
const keyFor = (ip: string) => ipIdentifier(header(ip));

/** Runs `fn`, and returns the `CustomError` it must have thrown. */
function rejection(fn: () => unknown): CustomError {
  let returned: unknown;
  try {
    returned = fn();
  } catch (error) {
    if (error instanceof CustomError) return error;
    throw error;
  }
  throw new Error(
    `expected a CustomError, but the call returned ${JSON.stringify(returned)}`
  );
}

/**
 * `getClientIp` reads `process.env.NODE_ENV` at CALL time, so both branches are
 * drivable from one process. Restored after every test, including a failing one.
 */
const REAL_NODE_ENV = process.env.NODE_ENV;

/**
 * `ipIdentifier` logs a diagnostic on the failure path — captured rather than
 * printed, and installed once for the whole file so the spy is never reassigned
 * from inside a hook. Restored at the end because `spyOn` outlives the file.
 */
const consoleErrorCalls: unknown[][] = [];
const consoleErrorSpy = spyOn(console, 'error').mockImplementation(
  (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  }
);

beforeEach(() => {
  consoleErrorCalls.length = 0;
});

afterEach(() => {
  if (REAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = REAL_NODE_ENV;
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

describe('only the edge header is trusted', () => {
  test.each([
    'x-forwarded-for',
    'x-real-ip',
    'forwarded',
    'x-client-ip',
    'client-ip',
    'true-client-ip',
    'fastly-client-ip',
    'x-vercel-forwarded-for',
  ])('%s resolves no ip, and the request fails closed', (name) => {
    // Derived, so the table cannot drift into claiming a TRUSTED header is
    // untrusted: if one of these is ever added to the list, this fails here
    // rather than passing while asserting the opposite of the truth.
    expect([...TRUSTED_IP_HEADERS]).not.toContain(name);

    const headers = header('203.0.113.7', name);
    expect(getClientIp(headers)).toBeNull();
    expect(rejection(() => ipIdentifier(headers)).status).toBe(
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
  });

  test('every header the trusted list names is actually read', () => {
    // `getClientIp` reads `TRUSTED_IP_HEADERS[0]` and nothing else, while
    // `lib/auth.ts` hands Better Auth the WHOLE array as `ipAddressHeaders`. A
    // second entry would be honoured there and ignored here, so one request
    // would carry two different client IPs — this limiter's and the session
    // row's. One entry today; this fails the moment that stops being true.
    for (const name of TRUSTED_IP_HEADERS)
      expect(getClientIp(header('203.0.113.7', name))).toBe('203.0.113.7');
  });

  test('the trusted header wins when x-forwarded-for disagrees', () => {
    const headers = new Headers({
      [TRUSTED_HEADER]: '203.0.113.7',
      'x-forwarded-for': '198.51.100.9',
    });

    expect(getClientIp(headers)).toBe('203.0.113.7');
    expect(ipIdentifier(headers)).toBe('ip:203.0.113.7');
  });

  test('two edges disagreeing on the trusted header fails closed', () => {
    // A repeated header is joined with ", " by `Headers`, which is not an IP —
    // so a second upstream appending its own value denies the request instead of
    // silently picking one of them.
    const headers = new Headers();
    headers.append(TRUSTED_HEADER, '203.0.113.7');
    headers.append(TRUSTED_HEADER, '198.51.100.9');

    expect(headers.get(TRUSTED_HEADER)).toContain(',');
    expect(getClientIp(headers)).toBeNull();
  });
});

describe('a value that is not an address is refused', () => {
  test.each([
    ['empty', ''],
    ['not an address at all', 'not-an-ip'],
    ['an x-forwarded-for style list', '203.0.113.7, 70.41.3.18'],
    ['an octet out of range', '203.0.113.256'],
    ['a port suffix', '203.0.113.7:8080'],
    ['a CIDR block', '203.0.113.0/24'],
    ['a hostname', 'localhost'],
    ['markup', '<script>alert(1)</script>'],
    ['a zone index', 'fe80::1%eth0'],
    ['a percent-encoded zone index', 'fe80::1%25eth0'],
    ['too many hextets', '1:2:3:4:5:6:7:8:9'],
    ['over the length cap', '0'.repeat(46)],
  ])('%s', (_label, value) => {
    const headers = header(value);
    expect(getClientIp(headers)).toBeNull();
    expect(rejection(() => ipIdentifier(headers)).status).toBe(
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
  });

  test('surrounding whitespace is stripped by Headers before we see it', () => {
    // Worth knowing which layer does it: the value never reaches `getClientIp`
    // padded, so the absence of a `.trim()` there is not a hole.
    const headers = header('  203.0.113.7  ');

    expect(headers.get(TRUSTED_HEADER)).toBe('203.0.113.7');
    expect(getClientIp(headers)).toBe('203.0.113.7');
  });

  test('the longest address the schema accepts is exactly the length cap', () => {
    // `MAX_IP_LENGTH` is 45 and cannot be isolated by a test: the longest string
    // the ipv4/ipv6 schema accepts is this 45-character mapped form, so nothing
    // valid is ever long enough to be rejected by length alone. The cap is a
    // cheap pre-filter in front of the schema, not an independent gate — which
    // is worth pinning, because raising the schema's reach (a zone index, say)
    // without raising the cap would silently start refusing valid addresses.
    const longest = '0000:0000:0000:0000:0000:ffff:255.255.255.255';

    expect(longest).toHaveLength(45);
    expect(getClientIp(header(longest))).toBe(longest);
    expect(getClientIp(header(longest + '0'))).toBeNull();
  });
});

describe('the refusal is 503, not 400', () => {
  test('an unresolvable ip throws a CustomError carrying SERVICE_UNAVAILABLE', () => {
    const error = rejection(() => ipIdentifier(new Headers()));

    expect(error).toBeInstanceOf(CustomError);
    expect(error.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(error.status).not.toBe(HTTP_STATUS.BAD_REQUEST);
    // Pinned to the wire value once, because the distinction is the point: the
    // client did nothing wrong, and the privacy-preserving catches in
    // `otp/verify` and `forgot-password/reset` re-exempt exactly 429/503/500/422
    // and collapse everything else into the generic answer. At 400 a
    // misconfigured edge would read as "code sent" / "invalid or expired"
    // instead of an outage.
    expect(HTTP_STATUS.SERVICE_UNAVAILABLE).toBe(503);
  });

  test('the message reflects nothing the caller sent', () => {
    const marker = 'reflect-me-203.0.113.7';
    const error = rejection(() =>
      ipIdentifier(
        new Headers({
          [TRUSTED_HEADER]: marker,
          'user-agent': marker,
          host: marker,
        })
      )
    );

    expect(error.message).not.toContain(marker);
  });

  test('the operator gets one diagnostic line, and it cannot be forged', () => {
    const headers = new Headers({
      'x-forwarded-for': '198.51.100.9',
      host: 'origin.invalid',
    });
    rejection(() => ipIdentifier(headers));

    expect(consoleErrorCalls).toHaveLength(1);
    const line = String(consoleErrorCalls[0]?.[0]);

    // The untrusted header IS the diagnostic — this is the one place its value
    // is wanted, because "which header did arrive" is what identifies the
    // misconfiguration. It goes through `sanitizeForLog`, so it arrives as a
    // single line no caller-supplied value can break out of.
    expect(line).toContain('missing client ip headers');
    expect(line).toContain('198.51.100.9');
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
  });
});

describe('the development fallback', () => {
  test('development resolves loopback instead of failing closed', () => {
    // `DEVELOPMENT_FALLBACK_IP` is not exported, so the value is asserted here
    // once — it has to be loopback, not merely "some address", or a developer
    // machine would bucket itself somewhere routable.
    process.env.NODE_ENV = 'development';

    expect(getClientIp(new Headers())).toBe('127.0.0.1');
    expect(ipIdentifier(new Headers())).toBe('ip:127.0.0.1');
  });

  test('development swallows a MALFORMED header too, not just a missing one', () => {
    // The branch's real shape, and worth pinning: the fallback is reached
    // whenever the header fails to parse, so locally a garbage `cf-connecting-ip`
    // reads as loopback rather than as a fault. Nothing is broken by it — the
    // branch cannot be reached outside development, `server.ts` validates
    // `NODE_ENV` against exactly three values before any module loads — but it
    // does mean a header bug is invisible on a developer machine.
    process.env.NODE_ENV = 'development';

    expect(getClientIp(header('not-an-ip'))).toBe('127.0.0.1');
    expect(getClientIp(header('203.0.113.7, 70.41.3.18'))).toBe('127.0.0.1');
  });

  test('development still prefers a real trusted header', () => {
    process.env.NODE_ENV = 'development';

    expect(getClientIp(header('198.51.100.9'))).toBe('198.51.100.9');
    expect(ipIdentifier(header('198.51.100.9'))).toBe('ip:198.51.100.9');
  });

  test.each(['production', 'test', 'Development', 'DEVELOPMENT', ''])(
    'NODE_ENV=%s fails closed',
    (value) => {
      // Exact match, so no near-spelling opens the fallback.
      process.env.NODE_ENV = value;

      expect(getClientIp(new Headers())).toBeNull();
      expect(rejection(() => ipIdentifier(new Headers())).status).toBe(
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );
    }
  );

  test('the branch is read per call, not captured at module load', () => {
    // What makes both directions testable in one process — and the reason a
    // stray `NODE_ENV` rewrite anywhere in a request path would change how the
    // limiter identifies every caller from that moment on.
    process.env.NODE_ENV = 'production';
    expect(getClientIp(new Headers())).toBeNull();

    process.env.NODE_ENV = 'development';
    expect(getClientIp(new Headers())).toBe('127.0.0.1');

    process.env.NODE_ENV = 'production';
    expect(getClientIp(new Headers())).toBeNull();
  });
});

/**
 * Each row is one address written as its eight hextets, canonically (lowercase,
 * no leading zeros). The expected /64 is the first four BY CONSTRUCTION, so no
 * reference parser is needed to know the right answer, and every row is asked
 * twice — fully expanded, and with its longest zero run compressed to `::`.
 *
 * Rows 1, 2 and 8 are three hosts in one /64; rows 5 and 6 are `::1` and `::`,
 * which share the all-zero /64. Both directions of the invariant therefore have
 * real content: the table would not detect a bucket that merged everything, nor
 * one that merged nothing.
 */
const ADDRESSES: string[][] = [
  ['2001', 'db8', '1', '2', '3', '4', '5', '6'],
  ['2001', 'db8', '1', '2', '0', '0', '0', '9'],
  ['2001', 'db8', '1', '3', '3', '4', '5', '6'],
  ['2001', 'db8', '0', '0', '0', '0', '0', '1'],
  ['0', '0', '0', '0', '0', '0', '0', '1'],
  ['0', '0', '0', '0', '0', '0', '0', '0'],
  ['fe80', '0', '0', '0', '0', '0', '0', '1'],
  ['2001', 'db8', '1', '2', '0', '0', '0', '0'],
  ['0', '0', '3', '4', '5', '6', '7', '8'],
  ['2001', '0', '0', '4', '5', '6', '7', '8'],
];

/** Replaces the longest run of zero hextets with `::`, as RFC 5952 requires. */
function compress(hextets: string[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < hextets.length;) {
    if (hextets[i] !== '0') {
      i += 1;
      continue;
    }
    let end = i;
    while (end < hextets.length && hextets[end] === '0') end += 1;
    if (end - i > bestLength) {
      bestLength = end - i;
      bestStart = i;
    }
    i = end;
  }
  if (bestLength < 2) return hextets.join(':');
  return `${hextets.slice(0, bestStart).join(':')}::${hextets.slice(bestStart + bestLength).join(':')}`;
}

const prefixOf = (hextets: string[]) => hextets.slice(0, 4).join(':');

describe('IPv6 is bucketed by its /64', () => {
  test.each(
    ADDRESSES.map((hextets) => [
      hextets.join(':'),
      compress(hextets),
      `ip:${prefixOf(hextets)}::/64`,
    ])
  )('%s and %s are one budget: %s', (expanded, compressed, expected) => {
    // Two spellings of one address must not be two budgets. ISPs hand a whole
    // /64 to a single customer, so a host that keeps its full address would
    // rotate past any per-IP cap for free.
    expect(keyFor(expanded)).toBe(expected);
    expect(keyFor(compressed)).toBe(expected);
  });

  test('one /64 is one key, and two /64s are never one key', () => {
    // The invariant rather than the strings, in both directions.
    const keyByPrefix = new Map<string, string>();

    for (const hextets of ADDRESSES) {
      const prefix = prefixOf(hextets);
      for (const spelling of [hextets.join(':'), compress(hextets)]) {
        const key = keyFor(spelling);
        const known = keyByPrefix.get(prefix);
        if (known === undefined) keyByPrefix.set(prefix, key);
        else expect(key).toBe(known);
      }
    }

    // Distinct prefixes must have produced distinct keys — a bucket that
    // collapsed everything to one key would satisfy the loop above.
    expect(new Set(keyByPrefix.values()).size).toBe(keyByPrefix.size);
    expect(keyByPrefix.size).toBeGreaterThan(1);
  });

  test(':: and ::1 share the all-zero /64', () => {
    expect(keyFor('::')).toBe(keyFor('::1'));
    expect(keyFor('::1')).toBe('ip:0:0:0:0::/64');
  });

  test('a zone index never reaches the bucket at all', () => {
    // `reports/test-strategy.md` and the brief both list `fe80::1%eth0` as a
    // bucketing case. It is not one: the ipv6 schema rejects the zone suffix, so
    // the request fails closed before `ipBucket` sees anything. Corrected here
    // rather than dropped, and paired with the same address without the zone so
    // the difference is visible.
    expect(getClientIp(header('fe80::1%eth0'))).toBeNull();
    expect(rejection(() => ipIdentifier(header('fe80::1%eth0'))).status).toBe(
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
    expect(keyFor('fe80::1')).toBe('ip:fe80:0:0:0::/64');
  });
});

describe('IPv4 is not bucketed', () => {
  test.each(['203.0.113.7', '0.0.0.0', '255.255.255.255', '198.51.100.9'])(
    '%s is its own key, unchanged',
    (ip) => {
      expect(keyFor(ip)).toBe(`ip:${ip}`);
    }
  );

  test.each(['::ffff:1.2.3.4', '::ffff:203.0.113.7'])(
    'an IPv4-mapped address keeps its full form: %s',
    (ip) => {
      // The v4 suffix is a host, not a /64 block, so collapsing it would pool
      // 2^32 unrelated hosts into one budget. Note the resulting key carries
      // three colons in a row (`ip:` + `::ffff:…`), which is correct and only
      // looks wrong.
      expect(keyFor(ip)).toBe(`ip:${ip}`);
    }
  );

  test('an ip key can never collide with a user key', () => {
    // Both go into the same `${scope}:${identifier}` keyspace.
    expect(keyFor('203.0.113.7')).not.toBe(userIdentifier('203.0.113.7'));
  });
});

describe('pinned defect: the bucket keys the SPELLING, not the address', () => {
  // Every spelling below is the SAME /64 as `CANONICAL` and is accepted by
  // `getClientIp`, yet each gets its own rate-limit key — so one host holds
  // several per-IP budgets, which is exactly what the /64 collapse exists to
  // prevent. `ipBucket` splits the string it was handed instead of parsing the
  // address, and its comment ("Inputs already passed `getClientIp`'s ipv4/ipv6
  // validator, so colon-form is a sufficient discriminator") is the assumption
  // that fails: the validator accepts leading zeros, uppercase hex and the
  // embedded-IPv4 form, and normalises none of them.
  //
  // Not exploitable while ingress is Cloudflare-only — Cloudflare emits the
  // canonical lowercase compressed form — so this shares its exposure with the
  // TODO(proxy-trust) already tracked on the header itself. Pinned, not fixed:
  // `lib/rate-limit/api.ts` is not this file's to change.
  const CANONICAL = '2001:db8:1:2::5';

  test('the canonical spelling buckets correctly', () => {
    expect(keyFor(CANONICAL)).toBe('ip:2001:db8:1:2::/64');
  });

  test.each([
    ['leading zeros', '2001:0db8:0001:0002:0000:0000:0000:0005'],
    ['uppercase hex', '2001:DB8:1:2::5'],
    ['an embedded IPv4 tail', '2001:db8:1:2:0:0:1.2.3.4'],
  ])(
    '%s is one /64 with the canonical form, and gets its own key',
    (_label, spelling) => {
      expect(getClientIp(header(spelling))).toBe(spelling);
      expect(keyFor(spelling)).not.toBe(keyFor(CANONICAL));
    }
  );

  test('the embedded-IPv4 form escapes the /64 collapse entirely', () => {
    // The widest case of the same defect: the `.` test treats any dotted address
    // as IPv4-mapped and returns it whole, but the fully expanded form is legal
    // for ANY prefix — so every host in one /64 can be spelled this way and each
    // one is a fresh budget.
    const first = keyFor('2001:db8:1:2:0:0:1.2.3.4');
    const second = keyFor('2001:db8:1:2:0:0:1.2.3.5');

    expect(first).not.toBe(second);
    expect(first).not.toContain('/64');
  });

  test('a NAT64 address is not collapsed either', () => {
    // `64:ff9b::/96` is the well-known NAT64 prefix, and this spelling is what a
    // NAT64 middlebox emits. Same root cause as above.
    expect(keyFor('64:ff9b::1.2.3.4')).toBe('ip:64:ff9b::1.2.3.4');
  });
});
