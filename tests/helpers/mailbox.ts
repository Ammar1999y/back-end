/**
 * The SMTP sink.
 *
 * SMTP is the one egress path the `fetch` router in `./egress.ts` cannot see —
 * it is not HTTP — and `utils/otp.ts` builds its transport with
 * `nodemailer.createTransport({ service: 'gmail', … })`, a hardcoded service with
 * no env seam, memoised in a module-private variable. So the boundary has to be
 * the module.
 *
 * **`mock.module` is installed from the PRELOAD, never from a test file.** It is
 * process-wide and `mock.restore()` does not undo it (measured on Bun 1.4.0), so
 * a file-local mock of a shared module leaks into every file that runs after it
 * in the same worker — the exact trap that made `otp-global-breaker.test.ts`
 * replace the rate-limit barrel for the rest of the run. Installing it once, in
 * the preload, inverts that: every file in the worker gets the same transport,
 * deterministically, and no file can be surprised by another file's mock.
 */

/** One captured message, in the shape `sendMail` was called with. */
export interface SentMail {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
}

const sent: SentMail[] = [];

/**
 * Set by a test to make `sendMail` throw, e.g. an SMTP rejection.
 *
 * A holder object rather than a bare `let`: the setters below are exported
 * functions, and reassigning a module-level binding from inside one is the shape
 * that makes reset order invisible at the call site.
 */
const state: { failure: Error | null } = { failure: null };

export function sentMail(): readonly SentMail[] {
  return sent;
}

export function resetMailbox(): void {
  sent.length = 0;
  state.failure = null;
}

/**
 * Makes the next and every subsequent `sendMail` reject until `resetMailbox`.
 *
 * An `Error` carrying a `responseCode`, since `utils/otp.ts` reads that field to
 * decide whether an SMTP rejection is one of the known constants it is allowed
 * to surface.
 */
export function failNextMail(error: Error): void {
  state.failure = error;
}

/**
 * The replacement module.
 *
 * `default` only: `utils/otp.ts` does `import nodemailer from 'nodemailer'`, so
 * that is the binding that has to exist. `createTransport` returns a fresh
 * recorder each call rather than a shared one, because the production code
 * memoises its transport and a shared object would hide a second
 * `createTransport` call if one were ever added.
 */
export function nodemailerStub(): Record<string, unknown> {
  const transport = {
    sendMail: async (message: SentMail) => {
      if (state.failure) throw state.failure;
      sent.push(message);
      return { messageId: `stub-${sent.length}`, accepted: [message.to] };
    },
    verify: async () => true,
    close: () => {},
  };

  const api = { createTransport: () => transport };
  return { ...api, default: api };
}
