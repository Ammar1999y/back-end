/**
 * The two bucket names, read and trimmed ONCE.
 *
 * `lib/env.server.ts` compares them at boot — one bucket under both names would
 * make a publish copy an object onto itself and then delete the only copy — and
 * `lib/r2/client.ts` sends them to the SDK. Two reads of the same variable are
 * how ` dash-public` passed the comparison and reached the wire untrimmed, so
 * the compared value and the used value come from here or from nowhere.
 *
 * Whitespace-only is unset: an empty name would name no bucket anyway, and the
 * env rules treat an absent bucket as a disabled visibility.
 */
const named = (value: string | undefined): string | undefined => {
  return value?.trim() || undefined;
};

export const R2_PUBLIC_BUCKET = named(process.env.R2_PUBLIC_BUCKET);
export const R2_PRIVATE_BUCKET = named(process.env.R2_PRIVATE_BUCKET);
