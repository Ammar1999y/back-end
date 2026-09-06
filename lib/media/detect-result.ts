/**
 * What a byte-level check concluded about an upload, shared by every entry in
 * the allowlist so the upload route can map each refusal to one message.
 *
 * - `signature`: the bytes do not start the way the declared type must.
 * - `container`: the file is the right container (ZIP, compound file) but not a
 *   well-formed package of the declared type, or cannot be read within the caps.
 * - `mismatch`: a well-formed package of a DIFFERENT type than declared.
 * - `macros`: carries VBA.
 * - `embedded`: carries embedded objects or ActiveX controls.
 * - `encrypted`: a password-protected package, whose contents cannot be checked.
 */
export type DetectResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'signature'
        | 'container'
        | 'mismatch'
        | 'macros'
        | 'embedded'
        | 'encrypted';
    };
