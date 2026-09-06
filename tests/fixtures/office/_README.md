# Encrypted legacy Office fixtures

Real password-protected files from the Apache POI test corpus, used by
`tests/unit/media-allowlist.test.ts` to prove that `lib/media/cfb.ts` refuses
legacy encryption by reading the FIB and BIFF records, not directory names.
Synthetic fixtures cannot stand in for them: the encryption is inside the
streams, exactly where a name-only inspector never looks.

| File                               | What it carries                           |
| ---------------------------------- | ----------------------------------------- |
| `_PasswordProtected.doc`           | Word, RC4, `FibBase.fEncrypted`           |
| `_password_password_cryptoapi.doc` | Word, RC4 CryptoAPI, `FibBase.fEncrypted` |
| `_password_tika_binaryrc4.doc`     | Word, binary RC4, `FibBase.fEncrypted`    |
| `_password.xls`                    | Excel, RC4, `FilePass` record             |
| `_xor-encryption-abc.xls`          | Excel, XOR obfuscation, `FilePass` record |

Source: <https://svn.apache.org/repos/asf/poi/trunk/test-data/document/> and
<https://svn.apache.org/repos/asf/poi/trunk/test-data/spreadsheet/>, copied
2026-09-04. Licensed under the Apache License, Version 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>); copyright the Apache Software
Foundation. The files are unmodified.

Names carry the `_` prefix every file under `tests/fixtures/` must have
(`tests/unit/harness-layout.test.ts`).
