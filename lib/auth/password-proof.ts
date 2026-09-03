/**
 * Carries "this request's password was already verified" from `lib/auth.ts`'s
 * `before` hook to Better Auth's `password.verify`.
 *
 * The hook verifies the real plaintext through `verifyLoginAttempt` and
 * substitutes a one-shot proof for `body.password`; `verify` accepts only a live
 * proof for the hash it is handed. That inverts the failure direction of the
 * `async () => true` stub it replaces: a real plaintext reaching `verify` — what
 * an uncompensated path produces — matches nothing and returns `false`.
 *
 * A proof carries a SET of hashes because `verifyLoginAttempt` rehashes on a
 * pepper-generation change, so the row Better Auth reads a moment later may hold
 * either value. Binding to one would break login for users mid-rotation, or
 * force `returnPasswordProof: true`, which suppresses the upgrade entirely.
 *
 * `lib/auth.ts` is the only caller: a second one would be a second place
 * deciding what counts as a verified password.
 */
import crypto from 'node:crypto';

import { PASSWORD_MAX } from '@/utils/validation/constants';

/** Distinguishes a proof from a password in a log. Not a security boundary. */
const PROOF_PREFIX = 'pwproof_';

/** Constrained by the `PASSWORD_MAX` assertion at the bottom of this file. */
const PROOF_ENTROPY_BYTES = 96;

/** A proof only spans the `before` hook and the handler in the same request. */
const PROOF_TTL_MS = 60_000;

/** Swept on crossing rather than per mint, which would make a login burst quadratic. */
const SWEEP_THRESHOLD = 256;

interface PendingProof {
  readonly hashes: ReadonlySet<string>;
  readonly expiresAt: number;
}

/**
 * Process-local by design: the `before` hook and the handler always run in the
 * same process for the same request, so nothing needs to survive a restart — and
 * because it cannot, a restart cannot leave a usable proof behind.
 */
const pending = new Map<string, PendingProof>();

function sweepExpired(now: number): void {
  for (const [token, proof] of pending)
    if (proof.expiresAt <= now) pending.delete(token);
}

/**
 * `hashes` must contain every hash the account row could hold by the time the
 * handler reads it.
 */
export function mintPasswordProof(hashes: readonly string[]): string {
  const accepted = hashes.filter((hash) => hash.length > 0);
  if (accepted.length === 0)
    throw new Error('mintPasswordProof requires at least one non-empty hash');

  const now = Date.now();
  if (pending.size >= SWEEP_THRESHOLD) sweepExpired(now);

  const token = `${PROOF_PREFIX}${crypto.randomBytes(PROOF_ENTROPY_BYTES).toString('base64url')}`;
  pending.set(token, {
    hashes: new Set(accepted),
    expiresAt: now + PROOF_TTL_MS,
  });
  return token;
}

/**
 * Better Auth's `password.verify`, in full. Deletes before deciding, so a proof
 * is spent whether or not it matched and can never be replayed — including by a
 * second `verify` call inside one request.
 *
 * No constant-time compare, deliberately: both operands are hash-map lookups by
 * exact key, and the candidate is CSPRNG output that never leaves this process.
 */
export function consumePasswordProof(hash: string, candidate: string): boolean {
  const proof = pending.get(candidate);
  if (!proof) return false;
  pending.delete(candidate);
  return (
    proof.expiresAt > Date.now() && hash.length > 0 && proof.hashes.has(hash)
  );
}

/**
 * A proof must be LONGER than any password this application accepts, because
 * `lib/auth.ts` rejects every inbound `password` over `PASSWORD_MAX` — so no
 * value that survives validation can be one. Asserted rather than commented,
 * since it is a relationship between two constants that drift in separate edits.
 */
const PROOF_LENGTH =
  `${PROOF_PREFIX}${Buffer.alloc(PROOF_ENTROPY_BYTES).toString('base64url')}`
    .length;
if (PROOF_LENGTH <= PASSWORD_MAX)
  throw new Error(
    `password proof length (${PROOF_LENGTH}) must exceed PASSWORD_MAX (${PASSWORD_MAX}); ` +
      'raise PROOF_ENTROPY_BYTES so a proof can never be a valid password'
  );
