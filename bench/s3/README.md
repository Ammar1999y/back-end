# `@aws-sdk/client-s3` → Bun's built-in S3: feasibility

Answers one question: **can `lib/r2/client.ts` drop `@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner` for `Bun.S3Client`, given how this application
actually uses them?**

**Verdict: yes, but it is not a drop-in.** Three of the four S3 functions port
cleanly. `uploadToR2` does not: Bun's `S3Options` has no `cacheControl` and no
custom-metadata field, and `write()` **silently drops both** — no throw, no
warning, no header. `copyFileInR2` has no Bun equivalent at all. Both are
recoverable with a ~120-line SigV4 helper (`shared/sigv4.ts`), and a port that
skips it ships public images that are no longer cacheable, which nothing in this
repository would report. A fourth item is not about headers: Bun does not retry
an HTTP 5xx on a single `PUT`, where the aws-sdk retries three times.

None of the four is likely to be fixed for us on a useful timescale — the
upstream requests are open and unanswered, the one implementation attempt was
closed unmerged, and one of the four has no upstream issue at all. **See
"Watchlist" for the tracking links, the dated states, and which test in this
directory fails when a fix lands** — that inversion is how this benchmark doubles
as the tracker.

Unlike the other benchmarks here, this one measures no throughput. It compares
**what arrives at the bucket** — and `live-r2.ts` does the same against
Cloudflare, because a local origin cannot prove that R2 accepts what Bun sends.

## Layout

```text
bench/s3/
  shared/
    fake-s3.ts        a recording S3-compatible origin on 127.0.0.1
    sigv4.ts          an independent SigV4: verify a presigned URL, sign a request
    clients.ts        the two clients under test, one configuration
    candidate.ts      lib/r2/client.ts ported to Bun, for candidate.test.ts
  production-ops.test.ts   PutObject and DeleteObject — the only two verbs in use
  copy.test.ts             the CopyObject gap and three workarounds
  presign.test.ts          presigned URLs: parity, signature validity, expiry bounds
  read.test.ts             the read surface this codebase does not have yet
  errors.test.ts           error shapes, header injection, retry semantics
  multipart.test.ts        the streaming writer, partSize, queueSize, aborts
  bun14.test.ts            Bun 1.4 S3 changes absent from docs/bun-s3.md
  candidate.test.ts        the port, run against the original
  bunfig.toml              test config; read it, it is load-bearing
  run.ts                   entry point for the suite above
  live-r2.ts               the same questions against the real bucket
```

## Running it

```bash
# from the repo root
bun bench/s3/run.ts

# a single area
bun bench/s3/run.ts presign
```

`run.ts` exists because **`bun test bench/s3` from the repo root silently runs
nothing**: the root `bunfig.toml` pins discovery to `tests/`, and `bun test`'s
positional arguments are filename filters rather than paths. It starts `bun test`
with this directory as the working directory, which also keeps two things out:

- the root bunfig's `preload`, which installs
  `mock.module('@aws-sdk/client-s3', …)` process-wide for the real test suite —
  comparing a mocked aws-sdk against a real Bun client would measure the mock;
- every ambient object-storage credential. Bun loads `.env` from the working
  directory, so a bare `bun test` in `bench/s3` never sees the root one — but
  `run.ts` invoked from the repository root does, and a spawned child inherits its
  parent's environment whatever its cwd. So `run.ts` deletes every `S3_*`,
  `AWS_*` and `R2_*` name before spawning. `errors.test.ts` asserts the result,
  and is what caught the gap the day real credentials landed in `.env`.

Requires the **Bun** runtime, and the repo's `bun install` (both aws-sdk packages
are still dependencies — they are the baseline being compared against).

### Against the real bucket

```bash
# from the repo root, with R2 credentials in .env
bun bench/s3/live-r2.ts

# exercise the same 21 checks against the local origin instead — proves the
# probe runs, answers none of its questions
bun bench/s3/live-r2.ts --self-test
```

`live-r2.ts` is the half of this benchmark a local origin cannot do. It checks
the three things only Cloudflare can settle: that R2 **accepts** a signature Bun
produced (the unit suite only proves it is correct), that the hand-signed copy
`copy.test.ts` recommends actually works there, and that the dropped
`Cache-Control` and metadata are really absent from the stored object rather than
absent from the fake. It also re-checks the presign-past-7-days, unsigned-copy
and `s3://`-encoding findings, where the fake is knowingly more permissive than
S3.

It needs `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
`R2_PUBLIC_BUCKET`, and read-write access to that bucket. Without them it prints
what is missing and exits 2 without opening a socket.

Deliberately a plain script rather than a `bun test` file: `bun test
--env-file=…` accepts the flag and does not load the file (measured on 1.4.0), so
a test file would silently run with no credentials. Run from the repository root,
plain `bun` auto-loads `.env`, and the root bunfig's `[test] preload` — the one
that mocks the aws-sdk — does not apply outside `bun test`. The probe checks that
the aws-sdk in its process is the real one before it starts.

**Safety.** Every object is written under `bench-s3-live/<run token>/` with a
token fresh per run; cleanup lists that prefix and deletes it, and `assertOwnKey`
throws rather than delete a key outside it. It never lists or touches the rest of
the bucket, never writes to the private bucket, and refuses to start with
`NODE_ENV=production`. Cleanup runs in a `finally`, so a check that throws
halfway still leaves nothing behind; if a delete fails, it names the key and
exits non-zero.

## How it measures

**A recording origin, not a mock.** `shared/fake-s3.ts` serves a small
S3-compatible API on `127.0.0.1` and records every request: method, path, raw
query, headers, body. Both clients are pointed at it and the recordings are
diffed. Neither library is stubbed — `@aws-sdk/client-s3` speaks `node:http` and
Bun speaks its own native stack, and neither can tell this apart from R2. That
matters because every difference this benchmark found is a difference in a
**header**, and a header is invisible from the call site.

**An independent signer, not a trusted one.** `getPresignedUrl` hands a URL to a
browser and never sees the outcome, so a wrong signature looks exactly like a
right one until R2 answers 403 to somebody else. `shared/sigv4.ts` recomputes the
signature from the URL's own canonical inputs. It is calibrated by first
verifying a URL from `@aws-sdk/s3-request-presigner` — the implementation in
production today — and by rejecting a tampered one; only then is it pointed at
Bun. The same oracle verifies the header-auth signature of every live request,
which is how Bun's `write`/`delete`/`GET` signing is checked rather than assumed.

**Containment.** The credentials are shaped like R2's and valid nowhere;
`assertLocalOnly` fails a run in which any request left the loopback interface.

## Results

Measured on `bun 1.4.0 (34cbb9a40)`, `@types/bun 1.4.0`,
`@aws-sdk/client-s3 3.1114.0`, `@aws-sdk/s3-request-presigner 3.1114.0`, Windows
10 x64. 127 tests across 8 files, all passing.

**`live-r2.ts` has been run against a real Cloudflare R2 bucket: 21/21 checks
passed, and every prediction the local suite made held.** What that changed:

| Question the fake origin could not answer              | R2's answer                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Does R2 accept a signature Bun produced?               | **Yes** — presigned `GET` and `PUT` both 200                    |
| Does the hand-signed copy work? (workaround C)         | **Yes** — 200, bytes copied server-side                         |
| Does a presigned `PUT` + unsigned `x-amz-copy-source`? | **No** — `403 SignatureDoesNotMatch`, as predicted              |
| Are `Cache-Control` and metadata really dropped?       | **Yes** — absent from `HeadObject`, so the object, not the wire |
| Is a presigned URL past 7 days usable?                 | **No** — `400`, so the expiry clamp is load-bearing             |
| Does `region: 'weur'` work, or must it be `auto`?      | **Both work**, and so does `us-east-1` — no latent bug          |
| Does `s3://` double-encoding break a spaced key?       | **Yes** — `404` on R2 too                                       |
| Does a `ReadableStream` body get stringified on R2?    | **Yes** — 23 bytes stored, upload reported as success           |
| Does `list()` return `checksumAlgorithm`?              | **No** — R2 does not populate it; expect `undefined`            |

Two of those are new information the local suite could not have produced: the
copy workaround is **verified**, not merely recommended, and R2 leaves
`checksumAlgorithm` unset, so the Bun 1.4 field is an AWS-only convenience here.

The probe wrote 14 objects and removed all 14; a follow-up listing of the bucket
returned zero objects.

### Ports with no change in behaviour

| Function                                                                                                   | Evidence                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `deleteFromR2`                                                                                             | Same path, empty body, valid signature; rejects on failure, resolves on 204     |
| `getPresignedUrl`                                                                                          | Same path and `response-content-*` parameters; signature verifies; expiry exact |
| `getPublicUrl`, `isAllowedMimeType`, `getCacheControlHeader`, `getContentDisposition`, `getR2ConfigStatus` | No S3 dependency — five of the nine exports are untouched                       |

Object keys are byte-identical between the two clients, including the spaces,
non-ASCII letters and parentheses that `sanitizeFilename`'s allow-list
(`\p{L}\p{N}\p{Zs}_-()`) lets through into a key.

### Blockers

**1. `Cache-Control` cannot be sent, and is dropped silently.**
`getCacheControlHeader` exists to put `public, max-age=31536000, immutable` on
every public image, and `uploadImagesToR2` passes it on every upload. `S3Options`
has no such field; passing one anyway produces a `PUT` with no `cache-control`
header and no error. Every public image would be served uncacheable, and nothing
in the codebase would notice.

**2. Custom object metadata cannot be sent, and is dropped silently.**
`uploadImagesToR2` records `originalMimeType` and `originalSize` as object
metadata for converted images. aws-sdk sends `x-amz-meta-originalmimetype` and
`x-amz-meta-originalsize`; Bun sends neither, and again raises nothing. See
"What is actually used" below — this one has no reader today, which changes what
it costs.

**3. There is no copy operation.** `S3Client.prototype` is exactly
`delete, exists, file, list, presign, size, stat, unlink, write`, and `S3File`
adds no copy either. `copyFileInR2` has no caller today, but it is exported and
its comment names the feature it exists for (attaching an upload to a record,
with the retention sweep cleaning up the original).

**4. A single `PUT`/`DELETE`/`GET` is not retried on an HTTP 5xx.** `retry: 3`
makes exactly one attempt; the aws-sdk makes three and therefore rides out a
transient 503. `retry` covers network errors, not error statuses. Multipart part
uploads are the exception — there `retry` is honoured (attempts = `retry + 1`).

Blockers 1–3 are all fixable the same way, which is what `shared/candidate.ts`
demonstrates: sign the `PUT` directly and the headers are expressible again.
`candidate.test.ts` asserts the stored headers then match aws-sdk's exactly, and
the signed path is strictly better in one respect — it binds the body hash into
the signature, which Bun's own `write()` does not. Blocker 4 needs an
application-level retry loop; `errors.test.ts` shows a three-attempt wrapper
restoring the old behaviour.

Three ways forward, in the order they should be considered:

1. **Bun plus a signing helper** (`shared/candidate.ts`). Removes both
   dependencies. Costs ~120 lines of SigV4 that has to be right — the tests here
   are how you would know it is.
2. **Stay on the aws-sdk.** No work, no risk. The Bun 1.4 notes list
   `@aws-sdk/client-s3` streaming uploads as working under Bun, so this is not a
   deprecation path.
3. **Bun alone, dropping `Cache-Control` and the metadata.** Cheapest, and a
   product decision rather than an engineering one: it makes public images
   uncacheable at the CDN.

### Watchlist — upstream status, snapshot 2026-08-24

**This is the section to re-read before deciding to migrate.** Every state below
was read off `oven-sh/bun` on the date in the heading, not remembered. Re-check
it rather than trusting it: 1.4 is days old and the S3 surface moves.

The fastest way to re-check is not to open ten tabs. **Every finding here is
asserted as the _current_ behaviour, so an upstream fix makes a test in this
directory fail.** Run `bun bench/s3/run.ts`; a red test is a fix landing, and the
table under "What flips when a fix lands" says which is which.

The two header blockers are **known, open, and unaddressed**; the copy one has
been asked for and closed.

| Blocker                       | Upstream                                                                                            | State                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom headers generally      | [#16048](https://github.com/oven-sh/bun/issues/16048) — "Allow for custom S3 headers/query params"  | **Open** since 2024-12-29, no maintainer reply. Would fix `Cache-Control` and metadata in one stroke.                                                                                                                     |
| User metadata specifically    | [#17339](https://github.com/oven-sh/bun/issues/17339) — "S3 — Conditional Writes & User Metadata"   | **Open** since 2025-02-14, no maintainer reply. Reporter says it blocks their adoption; they use the aws-sdk.                                                                                                             |
| User metadata, implementation | [#26154](https://github.com/oven-sh/bun/pull/26154) — `feat(s3): add custom metadata support`       | **Closed unmerged** 2026-06-04, opened 2026-01-16 by a Bun maintainer. Closed on review grounds (`JSRef` lifetime, duplication), not on principle — but five months open and then closed is not a feature to plan around. |
| Reading metadata back         | [#19301](https://github.com/oven-sh/bun/issues/19301) — "Support retrieving S3 response metadata"   | **Open**. Even with a write path, `stat()` exposes no metadata.                                                                                                                                                           |
| Copy / rename                 | [#16208](https://github.com/oven-sh/bun/issues/16208) — asks for `cp()`, `rename()`, `mkdir()`      | **Closed** with nothing implemented. No other copy request found.                                                                                                                                                         |
| `Cache-Control` on presign    | [#18016](https://github.com/oven-sh/bun/issues/18016) — missing `ResponseCacheControl` in `presign` | **Open**. Different surface from the `PUT` header, but the same absence.                                                                                                                                                  |

Blocker 4 — no retry on an HTTP 5xx — has **no upstream issue at all**. Four
search formulations over `oven-sh/bun` found nothing, and the `s3` label carries
no equivalent report. It is the cheapest of the four to work around locally, so
that may be why.

#### Untracked findings — nothing upstream, so nothing to wait for

These reproduce on Bun 1.4.0 and on real R2, and no issue or PR covers them.
Filing them is the only way they get fixed, and each already has a minimal
reproduction in this directory:

| Finding                                                                                                                                                            | Reproduction                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `write()` never uses multipart with a known-length body, whatever the size — `docs/bun-s3.md` says it does, and `partSize` is ignored                              | `multipart.test.ts` › "write() never goes multipart"           |
| `write(ReadableStream)` stringifies to `[object ReadableStream]` on all three entry points — **silent data loss**, and `docs/bun-s3.md` lists the type as accepted | `multipart.test.ts` › "every write entry point stringifies it" |
| `write(new Response(stream))` streams correctly but returns `0` instead of the byte count                                                                          | `multipart.test.ts` › "reports 0 bytes written"                |
| `fetch("s3://bucket/key")` double-encodes a key containing a space and 404s where `client.file(key)` succeeds                                                      | `read.test.ts` › "double-encodes a key containing a space"     |
| An open-ended `slice(n)` sends `bytes=n-4503599627370494` rather than `bytes=n-`                                                                                   | `read.test.ts` › "an absurd upper bound"                       |

The `ReadableStream` one is the only member of that list I would call a bug
rather than a rough edge: it reports success and stores the wrong object.

#### Already fixed upstream — evidence the surface does move

| Was                                                                  | Fixed by                                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `presign` ignored `contentDisposition` / `type` — [#22529], [#25750] | [#25999], ships in 1.4. `presign.test.ts` confirms both parameters now appear — and this project needs them |
| Multipart `EntityTooSmall` from the writer — [#16452]                | [#16453]. `multipart.test.ts`'s writer cases pass cleanly                                                   |
| `S3File.write()` not throwing on a failed upload — [#16309]          | Closed. `errors.test.ts` asserts it rejects                                                                 |
| No virtual-hosted-style addressing — [#16272]                        | Implemented; `virtualHostedStyle` is in `S3Options`                                                         |

So the two blockers that matter here are not a general neglect of S3 — they are
specifically the ones nobody has landed.

#### If you stay on the aws-sdk instead, this is the risk to watch

| Issue                                                                                                                      | Why it matters here                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#27557](https://github.com/oven-sh/bun/issues/27557) — `node:https` response stream hangs under concurrent S3 `GetObject` | Under Bun, `@aws-sdk/client-s3` stops emitting `data`/`end` after ~7,500–8,300 of 10,000 concurrent downloads and hangs. **Bun's native `S3Client` completed all 10,000.** Reported on 1.3.10, closed as duplicate with no fix version named. Not reachable today — this app has no S3 read path — but it is the one finding that argues _for_ migrating |
| [#25375](https://github.com/oven-sh/bun/issues/25375) — high memory with `@aws-sdk/lib-storage` + a stream under Bun       | 1.5 GB RSS for a 1 GB upload against ~180 MB on Node. Closed, no fix noted. Not used here (`lib-storage` is not a dependency)                                                                                                                                                                                                                            |

[#22529]: https://github.com/oven-sh/bun/issues/22529
[#25750]: https://github.com/oven-sh/bun/issues/25750
[#25999]: https://github.com/oven-sh/bun/pull/25999
[#16452]: https://github.com/oven-sh/bun/issues/16452
[#16453]: https://github.com/oven-sh/bun/pull/16453
[#16309]: https://github.com/oven-sh/bun/issues/16309
[#16272]: https://github.com/oven-sh/bun/issues/16272

#### What flips when a fix lands

Each row asserts today's behaviour, so the listed test **fails** when upstream
changes it. That failure is the signal to revisit this document, not a
regression.

| If Bun gains…                                     | This test fails                                                                              | Then                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `cacheControl` in `S3Options`                     | `production-ops.test.ts` › "no field for Cache-Control and drops it in silence"              | **Blocker 1 gone.** Drop the signed-PUT fallback for it |
| custom metadata in `S3Options`                    | `production-ops.test.ts` › "no field for object metadata and drops it in silence"            | **Blocker 2 gone**                                      |
| any copy / move / rename method                   | `copy.test.ts` › "S3Client exposes no copy, move, or rename" (asserts the exact method list) | **Blocker 3 gone.** Drop `signRequest` from the port    |
| retry on HTTP 5xx                                 | `errors.test.ts` › "Bun does not retry a 5xx, with retry: 3 or without it"                   | **Blocker 4 gone.** Drop the application retry wrapper  |
| multipart for a large known-length `write()`      | `multipart.test.ts` › "write() never goes multipart"                                         | Only matters if the 1 MB upload cap is ever raised      |
| real `ReadableStream` support                     | `multipart.test.ts` › "every write entry point stringifies it"                               | A streaming upload path becomes possible                |
| a correct byte count for a streamed `Response`    | `multipart.test.ts` › "reports 0 bytes written"                                              | Cosmetic                                                |
| single-encoded `s3://` keys                       | `read.test.ts` › "double-encodes a key containing a space"                                   | `s3://` becomes interchangeable with `client.file()`    |
| `%3A` in `X-Amz-Credential` ([#24422])            | `presign.test.ts` › "a colon in the access key id is left unencoded"                         | Only matters if the provider stops being R2             |
| `Promise<void>` matching the runtime for `delete` | `production-ops.test.ts` › "delete resolves to true"                                         | Cosmetic                                                |

`live-r2.ts` is the other half: re-run it after a Bun upgrade and the same
inversion applies — its "bun write drops Cache-Control and metadata" check fails
when that stops being true.

### What is actually used

Asked because a blocker for a capability nothing calls is a different decision
from one on the hot path. Audited by grep over `lib/`, `app/`, `db/`,
`scripts/`, excluding this directory:

| Capability              | Used today?                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cache-Control`         | **Yes, on every upload.** `lib/r2/upload-helper.ts:313` → `getCacheControlHeader`. The only blocker with a user-visible effect: `public, max-age=31536000, immutable` is what stops the CDN re-fetching every image.                                                                                                                                                                                                                                    |
| Object metadata         | **Written, never read.** `lib/r2/upload-helper.ts:321` sends `originalMimeType`/`originalSize`; no code path retrieves them, and the app has no S3 read path at all. But note `db/schema.ts`'s `files` table stores only the FINAL `mimeType` and `sizeBytes` — R2 metadata is the sole record of the pre-conversion values. Dropping it loses provenance permanently rather than breaking a feature. Two nullable columns on `files` would replace it. |
| Copy                    | **No caller.** `copyFileInR2` is exported and unreferenced (it carries a `@knip-ignore`). It is the attach-an-upload-to-a-record step the retention sweep is waiting for, so it is planned work rather than dead code.                                                                                                                                                                                                                                  |
| `ReadableStream` upload | **No.** Zero `ReadableStream` or `.stream()` uses in `lib/`, `app/`, `db/`. Uploads arrive as `File` and become a `Buffer`.                                                                                                                                                                                                                                                                                                                             |
| Multipart               | **Unreachable.** `app/api/upload/image/handler.ts` caps a request at `MAX_IMAGE_SIZE` = 1 MB and optimisation targets `SERVER_MAX_IMAGE_SIZE` = 0.2 MB; the default `partSize` is 5 MB.                                                                                                                                                                                                                                                                 |
| Retry on 5xx            | **Yes, implicitly.** Every `uploadToR2` and `deleteFromR2` call gets the aws-sdk's three attempts today. Nothing in the codebase retries, so the resilience is entirely the SDK's.                                                                                                                                                                                                                                                                      |

So the ranking is: `Cache-Control` is a real regression, retry is a real
regression, metadata is a provenance loss with no current reader, and copy and
streaming are future work.

### Differences worth knowing either way

| Difference                                                                                                                               | Direction                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Bun signs `UNSIGNED-PAYLOAD` and sends no `x-amz-checksum-crc32`; aws-sdk signs the body hash and sends a CRC32                          | aws-sdk better (integrity)                                            |
| `presign({ expiresIn: 0 })` throws in Bun, signed happily in aws-sdk                                                                     | Bun better                                                            |
| `presign({ expiresIn: > 7 days })` is signed by Bun, refused by aws-sdk                                                                  | aws-sdk better                                                        |
| `write({ type: 'text/plain' })` becomes `text/plain;charset=utf-8`; `image/*` and `application/pdf` pass through unchanged               | no current effect                                                     |
| Errors: Bun raises `S3Error` with `code` = the S3 code; aws-sdk sets `name` = the S3 code                                                | neutral; any matcher has to move                                      |
| `delete()`/`unlink()` resolve `true` while `@types/bun@1.4.0` declares `Promise<void>`                                                   | neutral                                                               |
| `stat()`'s fields are prototype getters, so `JSON.stringify(stat)` is `{}`                                                               | neutral; matters when logging                                         |
| `write()` never uses multipart — at 6 MB, 20 MB or 64 MB it sends one `PUT`, and `partSize` is ignored. Only `writer()` chunks.          | contradicts `docs/bun-s3.md`                                          |
| `write()` given a `ReadableStream` stringifies it: 3 MB of stream becomes a 23-byte `[object ReadableStream]`, on all three entry points | **silent data loss**                                                  |
| `write(new Response(stream))` streams correctly but returns `0` instead of the byte count                                                | neutral; wrong number in any log                                      |
| `fetch("s3://bucket/key")` double-encodes a key containing a space and misses the object; `client.file(key)` does not                    | do not use `s3://` here                                               |
| An open-ended `slice(8)` sends `bytes=8-4503599627370494` rather than `bytes=8-`                                                         | neutral; R2 clamps it                                                 |
| `presign` leaves a `:` in the access key id unencoded ([#24422], open) — breaks `tenant:key` providers, not R2's hex keys                | not applicable to R2; asserted so it surfaces if the provider changes |
| `list()` entries carry `checksumAlgorithm` from AWS but **R2 leaves it unset** — measured live, so expect `undefined` here               | neutral; do not branch on it                                          |

[#24422]: https://github.com/oven-sh/bun/issues/24422

The `ReadableStream` item is the one to be careful about: `docs/bun-s3.md` lists
`ReadableStream` in `S3File.write`'s accepted union, `@types/bun@1.4.0` does
not, and the runtime agrees with the types in the worst available way — it
stringifies rather than rejecting, so the upload "succeeds". Use a `Response`
wrapper, which `multipart.test.ts` shows working.

### Capabilities the migration would add

Not needed today, but they are the other half of the decision, and `read.test.ts`
runs all of them:

- `Blob`-shaped reads: `text()`, `json()`, `bytes()`, `arrayBuffer()`, `stream()`
  — where the aws-sdk needs `Body.transformToString()` or a stream adapter.
- `slice(start, end)` becomes a `Range` request, on both `.text()` and
  `.stream()`.
- `stat`, `exists`, `size`, `list({ prefix })` as one-liners, which is what an
  orphan sweep over `temp/` would use.
- `new Response(s3File)` is a `302` to a presigned URL, so a route can hand an
  object to the browser without proxying the bytes.
- `presign()` is synchronous — no `await`, no request.
- Two direct dependencies removed, and with them the `@aws-sdk/*` and
  `@smithy/*` transitive tree.

### Bun 1.4 items not covered by `docs/bun-s3.md`

From <https://bun.com/blog/bun-v1.4>. Asserted in `bun14.test.ts` unless noted:

- **`requestPayer`** — new: `true` on the client or per operation sends
  `x-amz-request-payer: requester`, including on the initiate, every part, and
  the completion of a multipart upload.
- **`write()`/`writer()` accept `contentDisposition` and `contentEncoding`**, and
  `S3Options.contentEncoding` is newly typed.
- **`presign()` honours `contentDisposition` and `type`** — which is what makes
  `getPresignedUrl`'s two response-override options portable at all
  (`presign.test.ts`).
- **`slice(0, N).stream()` sends the correct `Range`** (`read.test.ts`) — it
  previously downloaded the whole object.
- **`queueSize` is respected instead of being forced to 255**
  (`multipart.test.ts`, measured as peak concurrent part uploads).
- **A `Content-Length: 0` + `Connection: close` reply is no longer misread as
  `ConnectionClosed`** — that is the shape of every S3 `PUT` and `DELETE`, and
  the bug caused spurious retries through connection-recycling proxies. One
  request each, verified over ten sequential operations.
- **`list()` entries expose `checksumAlgorithm`**; the misspelled
  `checksumAlgorithme` still resolves but is non-enumerable, so it is gone from
  `Object.keys()` and `JSON.stringify()`.
- **CR/LF is rejected in `contentDisposition`, `contentEncoding` and `type`**
  (`errors.test.ts`). Relevant because `getContentDisposition` builds its value
  from a filename; unreachable today because `sanitizeFilename` drops CR/LF,
  which is also asserted so that a widening of its allow-list fails here. The
  aws-sdk refuses too, with a different error — both fail closed.
- **Async stack traces from native I/O** now point at the `await` in application
  code. Worth having: `sanitizeForLog(error)` is what the upload path logs, and
  before this these errors had empty stacks.
- Two fixes are not observable from here and are recorded rather than tested: a
  memory leak in `list()`, and a leak when a download stream is cancelled while
  its socket is idle.

## A defect this benchmark found in existing code — since fixed

`getContentDisposition` used to interpolate the raw filename into the
`filename="…"` parameter. HTTP header values travel as Latin-1, so a non-ASCII
name — reachable, since `sanitizeFilename` keeps `\p{L}` — did not survive, and
did not survive consistently: `@aws-sdk/client-s3` substituted `U+FFFD` per code
point and Bun sent the raw UTF-8 bytes, so the same upload produced two different
stored headers and neither was the name. The `filename*=UTF-8''…` companion was
correct throughout, which is why no download was visibly broken.

Two smaller problems came with it: a `"` or `\` in the name ended the quoted
parameter early, and `encodeURIComponent` does not escape `!'()*`, none of which
is an RFC 5987 `attr-char` — so any filename with a parenthesis, which
`sanitizeFilename` permits, produced an invalid `ext-value`.

**Fixed** in `lib/r2/client.ts`: the `filename` parameter is now ASCII-only with
non-ASCII folded to `_`, quotes, backslashes and control characters dropped, and
`filename*` uses a proper `attr-char` encoder. Covered by
`tests/unit/content-disposition.test.ts` (18 cases, including CR/LF), and
`production-ops.test.ts` now asserts the _absence_ of the two-client divergence —
so it would fail again if that function went back to interpolating.

The sweep for other instances of the class found none:
`getContentDisposition` is the only place in application code that builds a
header value from caller-supplied text. `lib/http/response.ts` and
`lib/http/response-policy.ts` set headers from fixed or derived values.

## Caveats

- **The `*.test.ts` files never touch real R2** — `live-r2.ts` does, and it has
  been run (see Results). The local origin implements the parts of the S3 API this
  benchmark needs and deliberately does **not** enforce one rule Cloudflare does:
  that every `x-amz-*` header presented must be covered by the signature.
  `copy.test.ts` calls this out where it matters — the "presigned `PUT` plus an
  unsigned `x-amz-copy-source`" workaround passes against this origin, and R2
  answered `403 SignatureDoesNotMatch`, which is why the signed variant is the one
  recommended.
- **One live run, one bucket, one account.** Nothing here proves R2 behaves the
  same on another account, in the EU jurisdiction (a `.eu.` endpoint), or through
  a custom domain. Re-run `live-r2.ts` rather than trusting the table.
- **No TLS locally.** In the `*.test.ts` files both clients are pointed at
  `http://127.0.0.1`. Signature computation is scheme-independent, and
  `live-r2.ts` covers the HTTPS path.
- **The aws-sdk client is reproduced, not imported.** `lib/r2/client.ts` builds
  its endpoint from `R2_ACCOUNT_ID` at module load and cannot be redirected, so
  `shared/clients.ts` restates its constructor arguments (`forcePathStyle: true`,
  `region: 'weur'`). `production-ops.test.ts` reads the real file and fails if
  that copy drifts. Everything else the application decides — cache-control
  values, content disposition, MIME policy — is imported from the real module.
- **Retry counts are the library defaults on this machine.** The aws-sdk's three
  attempts come from its default `maxAttempts`; a different configuration would
  change that number without changing the conclusion.
- **Multipart is out of the current path.** `MAX_IMAGE_SIZE` is 1 MB and
  `SERVER_MAX_IMAGE_SIZE` is 0.2 MB, both far below the 5 MB default `partSize`.
  `multipart.test.ts` asserts that first, so the rest of that file is read as
  what would happen if the cap were raised.

## Tooling notes

- **`tsc` covers this directory.** The root `tsconfig.json` includes
  `**/*.ts`, so these files are type-checked by `bun run build` and `bun run
lint`. That is new: `bench/` was `.mjs`-only before.
- **`eslint` does not.** `eslint.config.mjs` ignores `bench/**`, and its comment
  gives "no tsconfig … plain `.mjs`" as the reason — no longer true of this
  directory. Left alone deliberately: widening the lint scope to `bench/**` would
  surface findings across four existing benchmarks and belongs in its own change.
- **`prettier` covers it** (`.prettierignore` does not exclude `bench/`), and
  these files are formatted. `bunfig.toml` has no Prettier parser, so
  `format:check` skips it; that is pre-existing behaviour for TOML here.
- **`knip`** already declares `bench/**` as an entry pattern, so nothing was
  added. The comment above that pattern claims `.mjs` only and no TypeScript
  under `bench/`, which this directory makes false; the comment is updated, the
  pattern is not.
- **No `results/` directory.** Unlike the other benchmarks this one produces no
  JSON — the assertions _are_ the output, and `bun test`'s exit code is the
  verdict.
