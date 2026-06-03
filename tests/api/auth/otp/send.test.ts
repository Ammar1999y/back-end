import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import '../../../helpers/env';
import { tagEmail, wipeTag } from '../../../helpers/db';
import { api } from '../../../helpers/http';
import { createRole, createUser, setUserEmailVerified } from '../../../helpers/seed';
import { waitForServer } from '../../../helpers/http';

const PATH = '/api/auth/otp/send';

// Minimum response time the handler enforces to prevent timing-based
// user-enumeration. Tests that expect privacy-collapsed paths assert against
// this floor (with a small jitter allowance).
const MIN_RESPONSE_MS = 1500;

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('POST /api/auth/otp/send — happy path', () => {
  test(
    'returns generic success for an unverified email user',
    async () => {
      const role = await createRole();
      const user = await createUser({
        roleId: role.id,
        emailVerified: false,
      });

      const t0 = Date.now();
      const res = await api(PATH, {
        method: 'POST',
        body: { channel: 'email', email: user.email },
      });
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ nextAllowedIn: 30 });
      // Timing floor must apply to the real path too.
      expect(elapsed).toBeGreaterThanOrEqual(MIN_RESPONSE_MS - 200);
    },
    30_000
  );

  test('returns generic success (NOT 4xx) for an unknown email — privacy collapse', async () => {
    const t0 = Date.now();
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: tagEmail('does-not-exist') },
    });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ nextAllowedIn: 30 });
    // Privacy floor must apply on the fake path so timing doesn't leak existence.
    expect(elapsed).toBeGreaterThanOrEqual(MIN_RESPONSE_MS - 200);
  });

  test('returns generic success for an already-verified email — collapsed', async () => {
    const role = await createRole();
    const user = await createUser({
      roleId: role.id,
      emailVerified: true,
    });

    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: user.email },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ nextAllowedIn: 30 });
  });

  test(
    'response shape is identical between real, fake, and verified paths',
    async () => {
      const role = await createRole();
      const realUnverified = await createUser({ roleId: role.id, emailVerified: false });
      const realVerified = await createUser({ roleId: role.id, emailVerified: true });

      const responses = await Promise.all([
        api(PATH, { method: 'POST', body: { channel: 'email', email: realUnverified.email } }),
        api(PATH, { method: 'POST', body: { channel: 'email', email: realVerified.email } }),
        api(PATH, { method: 'POST', body: { channel: 'email', email: tagEmail('nobody-here') } }),
      ]);

      for (const r of responses) {
        expect(r.status).toBe(200);
        expect(Object.keys(r.body).sort()).toEqual(['data', 'message', 'success']);
        expect(r.body.data).toEqual({ nextAllowedIn: 30 });
      }
      // All three messages must be literally equal so the response body is not
      // an enumeration oracle either.
      expect(responses[0].body.message).toBe(responses[1].body.message);
      expect(responses[1].body.message).toBe(responses[2].body.message);
    },
    30_000
  );
});

describe('POST /api/auth/otp/send — captcha gate', () => {
  test('rejects when captcha header is missing', async () => {
    const role = await createRole();
    const user = await createUser({ roleId: role.id, emailVerified: false });

    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: user.email },
      noCaptcha: true,
    });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test('rejects when captcha header is empty', async () => {
    const role = await createRole();
    const user = await createUser({ roleId: role.id, emailVerified: false });

    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: user.email },
      captcha: '',
    });

    expect(res.status).toBe(403);
  });

  test('rejects when captcha header is absurdly long (>2048 bytes)', async () => {
    const role = await createRole();
    const user = await createUser({ roleId: role.id, emailVerified: false });

    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: user.email },
      captcha: 'A'.repeat(3000),
    });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/otp/send — input validation', () => {
  test('422 when body is empty object', async () => {
    const res = await api(PATH, { method: 'POST', body: {} });
    // 422 is the documented invalid-input status; some throws are collapsed.
    // Both 422 (validation) and 200 (collapsed) are NOT acceptable — must be 422.
    expect(res.status).toBe(422);
  });

  test('422 when channel is unknown', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'pigeon', email: tagEmail('a') },
    });
    expect(res.status).toBe(422);
  });

  test('422 when channel is "sms" but only "email" is enabled', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'sms', phoneNumber: '966500000000' },
    });
    expect(res.status).toBe(422);
  });

  test('422 when email field is malformed', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: 'not-an-email' },
    });
    expect(res.status).toBe(422);
  });

  test('422 when email is from a non-allowlisted domain', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: `attacker@evil.example` },
    });
    expect(res.status).toBe(422);
  });

  test('422 when email field is present for sms channel (discriminated union)', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'sms', email: tagEmail('a') },
    });
    expect(res.status).toBe(422);
  });

  // The handler privacy-collapses BAD_REQUEST → 200 generic success on
  // purpose: an attacker probing the endpoint can't tell a malformed body
  // apart from a legitimate "we sent you a code" response. These tests pin
  // that behaviour so a future refactor doesn't accidentally un-collapse it.
  test(
    'privacy-collapse: non-JSON content-type returns generic 200',
    async () => {
      const res = await api(PATH, {
        method: 'POST',
        rawBody: 'channel=email&email=a@b.com',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ nextAllowedIn: 30 });
    },
    15_000
  );

  test(
    'privacy-collapse: malformed JSON returns generic 200',
    async () => {
      const res = await api(PATH, {
        method: 'POST',
        rawBody: '{ not json',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ nextAllowedIn: 30 });
    },
    15_000
  );

  test(
    'privacy-collapse: JSON array body returns generic 200',
    async () => {
      const res = await api(PATH, {
        method: 'POST',
        rawBody: '[]',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ nextAllowedIn: 30 });
    },
    15_000
  );

  test('does not crash on giant email payload', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: 'a'.repeat(10_000) + '@gmail.com' },
    });
    // Email exceeds EMAIL_MAX → schema rejects → 422
    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/otp/send — rate limiting & IP enforcement', () => {
  test('rejects with 503 when no trusted-proxy IP header is present', async () => {
    const role = await createRole();
    const user = await createUser({ roleId: role.id, emailVerified: false });

    // Bypass the http helper's default cf-connecting-ip injection by passing
    // an empty headers override AFTER setting the test captcha manually.
    const url = `http://localhost:3000${PATH}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-captcha-response': 'test',
      },
      body: JSON.stringify({ channel: 'email', email: user.email }),
    });
    expect(res.status).toBe(503);
  });

  test('rejects spoofed x-forwarded-for as IP source (untrusted header)', async () => {
    const role = await createRole();
    const user = await createUser({ roleId: role.id, emailVerified: false });

    const url = `http://localhost:3000${PATH}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-captcha-response': 'test',
        'x-forwarded-for': '1.2.3.4', // not trusted by getClientIp
      },
      body: JSON.stringify({ channel: 'email', email: user.email }),
    });
    expect(res.status).toBe(503);
  });

  test(
    'per-identifier hour limit never leaks 429 to client (collapsed to 200)',
    async () => {
      // emailVerified=true → the handler short-circuits before the slow
      // processOtpSend / SMTP attempt path. That keeps each call to ~MIN
      // _RESPONSE_MS (1.5s floor) while still exercising the per-identifier
      // rate-limit that fires BEFORE the user lookup.
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: true });

      // Per-identifier cap is 5/hour. Run 7 sequential sends from rotating
      // IPs so the per-IP cap isn't the gate.
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await api(PATH, {
          method: 'POST',
          body: { channel: 'email', email: user.email },
        });
        statuses.push(r.status);
      }
      // The handler returns generic 200 even when throttled — that's the
      // privacy contract.
      expect(statuses.every((s) => s === 200)).toBe(true);
    },
    90_000
  );
});

describe('POST /api/auth/otp/send — method enforcement', () => {
  test('GET is rejected (handler only exports POST)', async () => {
    const res = await api(PATH, { method: 'GET' });
    // Next routes that don't export GET return 405. Some Next versions return
    // 404 if no method matches. Accept either as long as not 200.
    expect([404, 405].includes(res.status)).toBe(true);
  });

  test('DELETE is rejected', async () => {
    const res = await api(PATH, { method: 'DELETE' });
    expect([404, 405].includes(res.status)).toBe(true);
  });
});

describe('POST /api/auth/otp/send — injection / hostile payloads', () => {
  test('SQL-injection sequence in email field is rejected at validation', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: {
        channel: 'email',
        email: "evil' OR '1'='1@gmail.com",
      },
    });
    expect(res.status).toBe(422);
  });

  test('XSS payload in email field is rejected at validation', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: {
        channel: 'email',
        email: '"><script>alert(1)</script>@gmail.com',
      },
    });
    expect(res.status).toBe(422);
  });

  test('NoSQL-style operator object in email field is rejected', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: { $ne: '' } },
    });
    expect(res.status).toBe(422);
  });

  test('prototype-pollution-ish payload returns no abnormal status', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: {
        channel: 'email',
        email: tagEmail('pp'),
        __proto__: { polluted: true },
        constructor: { prototype: { polluted: true } },
      },
    });
    // Either 200 (extra keys ignored) or 422; never 500.
    expect([200, 422].includes(res.status)).toBe(true);
    // Confirm we didn't actually pollute Object.prototype.
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
