# File Manager / Media Library — architecture and implementation plan (v3)

Status: plan, no production code yet. v3 incorporates the owner's answers of 2026-09-04 (both public and private files; same-origin UI; Arabic messages; documents in the first release; freedom to spike) and one repository invariant v2 violated (section 6.0). Section 12 records review dispositions; section 13 records what was measured in the spike.

Backend: this repository (Bun + Elysia, route table in `routes.ts`). UI: `../soft-house-dash-4` (Next 16 pages router, TanStack Query + Table, Radix, dnd-kit, react-dropzone, zustand, sonner), served from the same origin as the API.

**measured** = verified against the real public bucket (2026-09-03/04, throwaway prefixes, deleted) or against the harness PostgreSQL (2026-09-04, scratch tables, spike file deleted — section 13). **unverified** = a claim I could not test.

---

## 1. Decision summary

| Question                     | Decision                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source of truth for the tree | **PostgreSQL** (`folders` + `files`). R2 is the blob store, never queried to render a page.                                                                                                                                                                                                                   |
| Buckets                      | **Two buckets**, one per visibility, each optional via `.env` (section 2.5). A custom domain exposes a whole bucket, so one bucket cannot hold both.                                                                                                                                                          |
| Visibility                   | A property of the **folder subtree root**, inherited and enforced by a composite FK (**measured**). Files inherit their folder's visibility. Cross-visibility moves are refused by the database. Entity uploads take visibility from a server-owned per-resource policy. Never chosen by the client per file. |
| R2 object keys               | **Opaque and immutable**: `m/<yyyy>/<mm>/<file id>.<ext>`. Rename/move touch the database only.                                                                                                                                                                                                               |
| Folder model                 | Adjacency list, unique `(parent_id, lower(name))`, depth ≤ 10, ≤ 500 children, both enforced transactionally.                                                                                                                                                                                                 |
| File lifecycle               | `status` enum `pending → active → deleting`. Referrers may point only at `active` files, enforced by a composite FK `(file_id, file_status) → files(id, status)` (**measured**, section 6.2).                                                                                                                 |
| Network vs transaction       | **No transaction is ever open across an R2 call** (`db/limits.ts` invariant). Uploads and deletions are two-phase with the status column as the durable step marker.                                                                                                                                          |
| Upload path                  | **Server-proxied**, one file per request. New `POST /api/dash/media/files` for the library; `/api/upload/file` (renamed from `/api/upload/image`) for entity forms. Same pipeline module.                                                                                                                     |
| File types                   | **Allowlist by kind.** Images: PNG, WebP, SVG (existing pipeline). Documents: PDF in the first release; the table is extensible per project, and every entry must carry a magic-byte signature. Everything else is refused.                                                                                   |
| Delivery URL                 | Public bucket → custom domain URL. Private bucket → presigned GET on the S3 endpoint (bearer, ≤ 1 h). Downloads always presigned with `attachment`.                                                                                                                                                           |
| Entity association           | Strict FKs from owner tables (direct column or junction table), `on delete no action`. A code registry of usage sources answers "used by". `files.contextTable/contextId` are dropped.                                                                                                                        |
| Deletion                     | Phase A (tx): lock, `status='deleting'` — the composite FK refuses if referenced, before any byte is lost. Phase B (no tx): `DeleteObjects`. Phase C (tx): delete rows. Stuck `deleting` rows are retried by the sweep. Batch ≤ 50. Folders must be empty. No trash.                                          |
| Permissions                  | New page `media`: `view`, `create`, `edit`, `editOwn`, `delete`, `deleteOwn`. Migration grants it to system-scope roles.                                                                                                                                                                                      |
| Messages                     | Arabic, in `messages.ts` beside the handlers, like every sibling.                                                                                                                                                                                                                                             |

### Why immutable, opaque keys

Rewriting keys on rename/move means `CopyObject` + `DeleteObject` per object and **every public URL already embedded in content breaks**. With the path in the database a folder rename is one `UPDATE`. No filename in the key (stale after rename; leaks the uploader's filename in public URLs); no entity prefix (a create form has no owner id yet). The file id is the basename, so a collision is impossible without a bug; `If-None-Match: *` is still sent as a guard (**measured:** 412 on an existing key) and a 412 is treated as an invariant failure — logged, request fails, nothing cleaned up.

---

## 2. Cloudflare R2 S3 API alignment

Sources: https://developers.cloudflare.com/r2/api/s3/api/ , https://developers.cloudflare.com/r2/buckets/public-buckets/ , https://developers.cloudflare.com/r2/api/s3/presigned-urls/ , https://developers.cloudflare.com/r2/reference/consistency/ (all fetched 2026-09-03/04), plus live probing.

### 2.1 Operations this feature uses

| Operation                             | R2 support                                                                   | Use here                                           | Notes                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PutObject`                           | Yes (system metadata, conditionals, STANDARD/STANDARD_IA)                    | upload                                             | **measured:** `If-None-Match: *` → 412 on an existing key, 200 on a new one. `Cache-Control`, `Content-Disposition`, `x-amz-meta-*` stored. Installed SDK exposes `IfNoneMatch` on `PutObjectCommandInput`.                                                                                                             |
| `HeadObject`                          | Yes                                                                          | reconciliation, details                            | **measured:** missing key → `NotFound` (404).                                                                                                                                                                                                                                                                           |
| `GetObject` (presigned)               | Yes                                                                          | private objects, downloads                         | **measured:** `ResponseContentDisposition` override honoured. Docs: presigned URLs work only on `<account>.r2.cloudflarestorage.com`, never on a custom domain; expiry 1 s–7 days; "treat as bearer tokens", reusable until expiry.                                                                                     |
| `ListObjectsV2`                       | Yes (`prefix`, `delimiter`, `continuation-token`, `start-after`, `max-keys`) | **reconciliation only**                            | **measured:** `MaxKeys` capped at 1000 (`MaxKeys=1500` → 1000, `IsTruncated: true`). No sort/filter/search.                                                                                                                                                                                                             |
| `DeleteObject`                        | Yes                                                                          | single delete                                      | **measured:** missing key → 204. Idempotent.                                                                                                                                                                                                                                                                            |
| `DeleteObjects`                       | Yes (no MFA/object-lock)                                                     | batch delete, sweep, purge                         | **measured:** 1001 keys → `MalformedXML: The number of keys in the request must be between 1 and 1000 inclusive` (400); 1000 → OK; missing keys counted in `Deleted`, no `Errors`. Chunk at 1000.                                                                                                                       |
| `CopyObject`                          | Yes (`metadata-directive`, conditionals)                                     | not in MVP (section 2.3)                           | **measured:** `COPY` preserves headers and metadata; `REPLACE` overwrites. **measured bug:** `CopySource` must be percent-encoded per segment; a raw key with a space or Arabic letters throws `TypeError: Invalid character in header content ["x-amz-copy-source"]`. `copyFileInR2` passes the raw key — phase 0 fix. |
| Multipart family                      | Yes                                                                          | phase 3                                            | Doc caveat: re-uploading a part number replaces it; a failed replacement loses the original part.                                                                                                                                                                                                                       |
| `Get/PutBucketLifecycleConfiguration` | Yes (modern variant)                                                         | optional abort-incomplete-multipart rule (phase 3) | Only legacy `GetBucketLifecycle` is unimplemented.                                                                                                                                                                                                                                                                      |
| `Get/PutBucketCors`                   | Yes                                                                          | not needed for MVP (2.4)                           | **measured:** current token → `AccessDenied` (object-scoped token). Set in the Cloudflare console if ever needed.                                                                                                                                                                                                       |

### 2.2 Unsupported through the S3 API

| Missing via S3 API                                                                                | Consequence              | Our answer                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| Object tagging                                                                                    | No per-object labels     | Metadata in `files`; `x-amz-meta-*` for provenance only.                       |
| Versioning                                                                                        | No history/restore       | Omitted. Trash later = DB soft-delete + deferred purge.                        |
| ACLs, bucket policy, public-access block                                                          | No per-object visibility | Two buckets; visibility fixed at upload by folder/policy.                      |
| S3 Object Lock                                                                                    | No WORM via S3           | Not needed. R2 has native **Bucket Locks** outside the S3 API.                 |
| S3 notifications                                                                                  | No hooks via S3          | Not needed. R2 has native **event notifications** (Queues) outside the S3 API. |
| Rename / move / batch copy                                                                        | S3 has none either       | DB-held paths.                                                                 |
| Website hosting, replication, legacy lifecycle, analytics, inventory, request payment, MFA delete | —                        | Not needed.                                                                    |

### 2.3 Composite operation, if a key ever has to change

Migration-only (never UI rename/move): `CopyObject` (percent-encoded `CopySource`, `MetadataDirective: REPLACE`, headers restated) → `HeadObject` on the destination comparing `ContentLength` and, where byte assurance matters, a SHA-256 stored at upload (**not** ETag: a multipart ETag is not a content hash) → update the row → `DeleteObject` the source (failure = orphan object, reported by reconciliation). Failure before the row update → delete the destination, leave the row.

**Region scope:** `lib/r2/client.ts` hard-codes `weur`; docs say `auto`; **measured:** both accepted. Switch to `auto` (phase 0).

**Presigned PUT, corrected (measured with the installed `@aws-sdk/s3-request-presigner`):** by default the presigner signs only `host` (`X-Amz-SignedHeaders=host`), so a PUT sent with a different `Content-Type` than the one in the command is accepted (200). With `signableHeaders: new Set(['content-type'])` the header is in the signature (`content-type;host`) and a mismatched body header is refused with 403 — exactly what Cloudflare's presigned-URL page states. A signed `ContentLength` is enforced either way. So a direct-to-R2 upload _can_ pin declared type and size; what it cannot do is validate bytes (magic bytes, SVG sanitisation, WebP re-encode, blurhash, PDF signature). Uploads stay server-proxied for that reason alone.

### 2.4 Delivery, cache and CORS

- **Public bucket URL = custom domain, not `r2.dev`** (docs: "rate-limited and should only be used for development purposes"). The custom domain must **not** share a cookie scope with the dashboard: the public bucket serves sanitised SVG and inline PDF, and either slipping through would otherwise run on the dashboard's cookie origin.
- **Cache vs delete.** Immutable-key objects are written with `public, max-age=31536000, immutable`; a custom domain caches at the edge, so a deleted public object may keep being served until the cached copy expires or is purged. Accepted for MVP; zone-scoped purge token is a phase-3 operational item.
- **CORS.** `<img src>` and link navigation need none. `fetch()` of an object or a direct upload does. MVP: previews via `<img>`; document preview via **navigation** to a presigned URL in a new tab (isolated origin); downloads via presigned URL with `attachment`. No bucket CORS rule for MVP. Frontend CSP `img-src` gains `R2_PUBLIC_URL` and the S3 endpoint host.

### 2.5 The custom-domain question, answered

Connecting a custom domain publishes **the whole bucket**: Cloudflare's public-bucket page offers no per-prefix or per-object restriction, only "use Cloudflare's existing security products" (Zero Trust Access, WAF token authentication, WAF custom rules) in front of the domain. A single-bucket design would therefore rest on a zone-level WAF rule to keep a `private/` prefix unreachable — configuration outside the repository, invisible to tests, and one edit away from publishing every private file. **Two buckets** put the boundary in the database (`bucket_type`) and in credentials, which is why the schema already has `bucketType`. The overhead is one more bucket and one more env var; there is no per-object public/private on R2 (no ACLs, section 2.2), so there is no simpler correct pattern.

Configuration, all from `.env`:

| Variable            | Meaning                                                            | Rule                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `R2_PUBLIC_BUCKET`  | Public bucket name                                                 | Optional. Enables the `public` visibility.                                                                                                 |
| `R2_PUBLIC_URL`     | Custom domain of the public bucket, `https://…`, no trailing slash | **Required whenever `R2_PUBLIC_BUCKET` is set** (a public object nobody can reach is a misconfiguration). Boot error in every environment. |
| `R2_PRIVATE_BUCKET` | Private bucket name                                                | Optional. Enables the `private` visibility.                                                                                                |
| credentials         | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`        | Required in production when any bucket is set.                                                                                             |

At least one bucket is required in production (boot error otherwise). `lib/r2/client.ts` derives `ENABLED_VISIBILITIES: ReadonlySet<BucketType>` once; creating a root folder or an entity policy with a disabled visibility answers 422; the list response carries `visibilities` so the UI hides the disabled option. `REQUIRED_IN_PRODUCTION` in `lib/env.server.ts` drops the two bucket names and gains the "at least one, and public implies URL" rule.

---

## 3. Folder architecture

### 3.1 Options considered

|                              | A. Pure R2 prefixes (`ListObjectsV2` + `Delimiter`)                                          | B. Database catalogue (chosen)              |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Rendering a folder           | ≥ 1 list call per view, ~250–600 ms (**measured**), lexicographic only, 1000-key pages       | One indexed query, any sort                 |
| Sort / filter / search       | Impossible server-side                                                                       | `lib/data-table/parsers.ts` already does it |
| Empty folders                | Marker objects `prefix/` (**measured:** the marker lists inside itself and must be filtered) | A row                                       |
| Rename/move folder           | Copy + delete every object; URLs change                                                      | One `UPDATE`                                |
| Metadata, usages, visibility | `x-amz-meta-*`, one `HeadObject` each; no visibility model                                   | Columns and FKs                             |
| Drift                        | None                                                                                         | Reconciliation job, read-only in phase 1    |

### 3.2 Schema changes (`db/schema.ts`, one migration; order in section 10)

```
file_status  enum ('pending','active','deleting')          -- new
bucket_type  enum ('public','private')                     -- existing, reused for folder visibility

folders
  id           uuid pk (uuidv7)
  parent_id    uuid null → folders.id                                     (null = root)
  visibility   bucket_type not null
  name         varchar(100) not null      -- NFC-normalised, trimmed, no '/', no control chars
  created_by   uuid null → users.id on delete set null
  timestamps
  unique (id, visibility)                                                 -- FK target
  foreign key (parent_id, visibility) references folders (id, visibility) -- child inherits, cannot diverge, cannot move across (measured)
  unique index ux_folders_parent_name on (parent_id, lower(name)) where parent_id is not null
  unique index ux_folders_root_name   on (lower(name))           where parent_id is null
  trigram index on name

files (changes)
  + status        file_status not null default 'pending'              -- replaces is_temporary
  - is_temporary                                                       -- dropped after backfill
  + folder_id     uuid null
  + display_name  varchar(150) not null                               -- add nullable → backfill from key basename → NOT NULL
  + kind          file_kind enum ('image','document') not null
  ~ size_bytes    bigint
  - context_table, context_id, enum file_context_table                 -- dropped (section 5.2)
  unique (id, status)                                                  -- FK target for referrers
  foreign key (folder_id, bucket_type) references folders (id, visibility)   -- a file's bucket matches its folder (measured)
  indexes: (folder_id, created_at, id), (folder_id, lower(display_name), id), (status, created_at) where status <> 'active'
  trigram index on display_name

referrers (per project; the rule every one must follow)
  file_id      uuid not null
  file_status  file_status not null default 'active' check (file_status = 'active')
  foreign key (file_id, file_status) references files (id, status) on update no action on delete no action
```

- The composite FK is what makes deletion TOCTOU-safe without a transaction across the network (section 6.2). **measured** in the spike: an active file with a referrer cannot be marked `deleting` or deleted; a referrer cannot be created on a `pending` or `deleting` file; the two concurrent orderings both end with the second statement blocked on the row lock and then refused.
- `NO ACTION`, not `RESTRICT`: RESTRICT raises SQLSTATE `23001 restrict_violation`, which `isForeignKeyViolation` (`utils/index.ts`, `23503` only) does not recognise (**measured**). Phase 0 extends the helper to both codes anyway, because the existing schema uses `onDelete: 'restrict'` in several places; today no handler reaches such a violation (the role delete pre-empts it with `NOT EXISTS`), so the gap is latent, not live.
- `DASHBOARD_PAGES` gains `media` (pgEnum migration) and `DEFAULT_PAGE_PERMISSIONS` gains `{ name: 'media', availablePermissions: ['view','create','edit','editOwn','delete','deleteOwn'] }`. Ownership: `files.uploaded_by`, `folders.created_by`. No `viewOwn` (a library you can only see your own uploads in is not a library).
- The migration inserts `role_permissions` for `media` on every `scope = 'system'` role: the checker has no system bypass (verified) and system roles are not editable from the dashboard, so without this the super-admin is locked out of the page.
- Depth ≤ 10 and ≤ 500 children enforced in the create/move transaction (`SELECT … FOR UPDATE` on the parent, then count). Stable secondary sort on `id`. File display names may repeat; folder names may not (case-insensitive).

### 3.3 Path resolution

The UI addresses folders by id; breadcrumbs come from one recursive CTE bounded by the depth cap. Root listing shows root folders only (each carries its visibility badge); files always live in a folder. No string paths cross the API.

---

## 4. API and service layer

All routes: `preAuth: 'ip-limit'`, `auth: 'permission'`, `response: 'envelope'`, `handlerRateLimit: true`, audit row in the same transaction as the database mutation. `RouteDefinition` allows GET/POST/PUT/DELETE only.

### 4.1 Routes

| Method & path                        | Body                                           | Permission                   | Purpose                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/dash/media`                | none                                           | `media.view`                 | Folder view. Query: `folder` (uuid; absent = root), data-table params (`sort` on `displayName`/`sizeBytes`/`createdAt`/`mimeType`; `filters` on `kind`/`mimeType`/`createdAt`; `search`), `scope=folder\|all`. `folder` scope → `{ breadcrumbs, folders, files, meta, visibilities }`; `all` → `{ files, meta }`. Only `status='active'` rows. |
| `POST /api/dash/media/files`         | multipart `file`; query `folder` (required)    | `media.create`               | Upload into a folder; visibility = the folder's. Kind resolved from the allowlist. Returns `{ id, kind, displayName, mimeType, sizeBytes, width, height, blurhash, url }`.                                                                                                                                                                     |
| `GET /api/dash/media/files/:id`      | none                                           | `media.view`                 | Details: metadata, `url`, `downloadUrl` (presigned attachment, 1 h), `previewUrl` (public URL or presigned inline, for documents), `usedBy` filtered by the caller's permissions.                                                                                                                                                              |
| `PUT /api/dash/media/files/:id`      | json `{ displayName?, folderId? }`             | `media.edit` / `editOwn`     | Rename/move. Database only; a cross-visibility move fails the composite FK → 422 with a clear message.                                                                                                                                                                                                                                         |
| `DELETE /api/dash/media/files`       | json `{ ids: uuid[] }` (≤ `IDS_ARRAY_MAX`)     | `media.delete` / `deleteOwn` | Section 6.2. Any referrer → 409 naming the usages the caller may see; nothing changes.                                                                                                                                                                                                                                                         |
| `POST /api/dash/media/folders`       | json `{ parentId?, name, visibility? }`        | `media.create`               | `visibility` accepted only for a root folder and only if enabled; children inherit. 409 on the unique index; 422 on caps.                                                                                                                                                                                                                      |
| `PUT /api/dash/media/folders/:id`    | json `{ name?, parentId? }`                    | `media.edit` / `editOwn`     | Rename/move. Rejects self/descendant destination, depth > 10, and (via the FK) a destination of another visibility.                                                                                                                                                                                                                            |
| `DELETE /api/dash/media/folders/:id` | none                                           | `media.delete` / `deleteOwn` | **Empty folders only**, else 409.                                                                                                                                                                                                                                                                                                              |
| `POST /api/upload/file`              | multipart `files`; query `resource`, `purpose` | `create`/`edit` on entity    | Renamed from `/api/upload/image` (no working consumer exists). Entity-form upload, `status='pending'`, `folder_id` null. `UPLOAD_PURPOSES[resource][purpose]` (code) fixes visibility and allowed kinds. Returns the same shape as the library upload, as an array. Its `resource`/`purpose` stay in the query (permission check before body). |

Rate limits (per user): reads 120/min; mutations 30/min `failClosed`; uploads — images keep the megapixel budget (`UPLOAD_MEGAPIXEL_BUDGET`/`UPLOAD_REQUEST_UNIT`, own scope per route); documents charge `max(2, ceil(MiB))` against 60/min. Two budgets, one route, chosen by kind.

Multi-file upload is a **client** queue: single-file requests, concurrency 2, per-file state, 429 honoured via `Retry-After` with backoff. Server ceiling 20 images/min/user stands.

### 4.2 Modules

```
lib/r2/client.ts            add listObjects, headObject, deleteObjects (chunk 1000), IfNoneMatch on put, ENABLED_VISIBILITIES;
                            fix CopySource encoding, region 'auto', drop `bucketType as 'public'` cast
lib/media/allowlist.ts      FILE_KINDS: { mime → { kind, ext, signature } } — images (existing) + documents (pdf); per-project extension point
lib/media/documents.ts      validateDocument(buffer, mime): signature check, size cap; no transform
lib/media/keys.ts           objectKey(fileId, ext)
lib/media/upload.ts         the shared pipeline: validate → insert pending → put → activate (section 6.1); used by both upload routes
lib/media/folders.ts        create / rename / move / delete-empty, caps, cycle check, breadcrumbs CTE
lib/media/files.ts          rename / move / details, fileUrl(), downloadUrl(), previewUrl()
lib/media/lifecycle.ts      claimFiles(tx, { ids, actorId }); deleteFiles({ ids }) three-phase; retryDeleting() for the sweep
lib/media/usages.ts         USAGE_SOURCES registry + usedBy(fileIds, callerPermissions)
lib/media/reconcile.ts      read-only drift report
lib/media/policy.ts         UPLOAD_PURPOSES (entity route visibility/kinds)
app/api/dash/media/*        handlers + messages.ts (Arabic)
utils/validation/media.ts   zod schemas
utils/index.ts              isForeignKeyViolation → 23503 or 23001
```

### 4.3 Error contract

`CustomError` + `handleApiError`; unique-violation resolver for the two folder indexes (exact-name Map); FK violations from the composite constraints mapped to 409 (referenced) / 422 (visibility mismatch) by constraint name, everything unknown falls through to 500.

### 4.4 Tests

- Unit: allowlist and signature checks (every admitted type has a signature — the rule `upload-validation.test.ts` already enforces for images), folder-name normalisation, key generation, URL derivation, `CopySource` encoding, `DeleteObjects` chunking, `isForeignKeyViolation` on 23001.
- Integration: folder CRUD and caps; visibility inheritance and cross-visibility move refusal; three-phase delete with R2 failure leaving `deleting` rows that the sweep then completes; referrer → 409 and no R2 call; the concurrent orderings from the spike, re-expressed against the real tables; claim vs sweep; 412 leaves the foreign object untouched; document upload (PDF accepted, fake `%PDF-` prefix with wrong MIME refused, executable refused); permission/own-scope boundaries; audit rows; `request.bodyUsed` admission order.
- `tests/helpers/object-store.ts` learns `ListObjectsV2Command`, `HeadObjectCommand`, `DeleteObjectsCommand` and a 412 injection.

---

## 5. Keys, lifecycle, association

### 5.1 Key scheme

`m/<yyyy>/<mm>/<file id>.<ext>` for every file, in whichever bucket its visibility selects. `<ext>` from the resolved MIME, never the client filename.

### 5.2 Association: strict FKs, no polymorphic columns

Owner tables reference files in one of two ways, both carrying the `file_status` companion column from section 3.2:

1. **Direct column** — `projects.cover_image_id` (+ `cover_image_status`). One image, reusable across owners.
2. **Junction table** — `project_images(project_id, file_id, file_status, sort_order)`. Many per record, ordered.

A file may be in a folder and used by several owners. Deleting a used file is refused by the database (409). A public entity should reference public files; the policy module decides that per purpose, and a unit test can assert it for each registry entry.

### 5.3 Usage registry

`USAGE_SOURCES`: `{ table, column, resource: DashboardPage, label }` per referrer. Drives `usedBy` (filtered to resources the caller may `view`; the rest reported as a count), the 409 message, and an integration test that fails when `information_schema.referential_constraints` shows a referrer to `files` missing from the registry.

### 5.4 Claiming

`claimFiles(tx, { ids, actorId })`: `UPDATE files SET status='active' WHERE id = ANY($ids) AND status='pending' AND uploaded_by=$actorId RETURNING id`; a count mismatch throws (422) — swept, already claimed, or someone else's upload. The caller inserts its FK rows in the same transaction; the composite FK sees the update. **measured:** claim and sweep are conditional updates on `status`; whichever runs first wins and the other matches zero rows after blocking on the row lock.

### 5.5 Rules

- Never build a key from user input; never expose `r2Key`; files are addressed by id.
- Visibility comes from the folder (library) or from `UPLOAD_PURPOSES` (entity); no request parameter names a bucket.
- Deleting an owner removes its FK rows in its own transaction; the files stay. Owner-scoped cleanup goes through `deleteFiles` explicitly.

---

## 6. Behaviour details

### 6.0 The invariant that shaped this section

`db/limits.ts`: _"Nothing may hold a transaction open across a network call to a third party"_ — the pool is 10 connections, and ten requests waiting on a hanging provider inside transactions stall every transactional path in the process. v2 held a transaction across `PutObject` and `DeleteObjects`. v3 does not: the `status` column is the durable step marker and the sweep is the retry.

### 6.1 Upload (both routes)

1. Authorise; admit through the limiter; read the multipart body.
2. Resolve kind from the allowlist by MIME **and** signature; refuse anything else. Images: existing `processImage`. Documents: `validateDocument` (signature `%PDF-` at offset 0, size ≤ `MAX_DOCUMENT_SIZE_MB` = 10). `MAX_REQUEST_BODY_BYTES` rises from 8 to 12 MiB; per-file caps stay per kind.
3. **Tx A:** insert the row `status='pending'` with `folder_id`/`bucket_type`/`kind`/`display_name` `RETURNING id`; commit.
4. `PutObject` with `IfNoneMatch: '*'`, headers from `getCacheControlHeader` (`no-store` for private) and `getContentDisposition` (`inline` for images; **`attachment` for documents in the public bucket** — a PDF is then never rendered on the public origin by default; the details drawer offers an explicit presigned inline preview).
5. **Tx B:** library route → `UPDATE … SET status='active' WHERE id=$ AND status='pending'`; entity route → leave `pending` for `claimFiles`. Audit.
6. Failures: put fails → `DELETE` the pending row (best effort; the sweep covers a miss). Tx B fails after a successful put → row stays `pending`, swept after the TTL together with its object. 412 → invariant failure, logged, row deleted, **no object cleanup**.

### 6.2 Deletion — one path for requests, the sweep and the purge

```
Phase A (tx):   SELECT … FOR UPDATE;  UPDATE files SET status='deleting' WHERE id = ANY($ids) AND status IN ('active','pending')
                → composite FK refuses if any referrer exists (measured) → 409, nothing changed
                audit rows; COMMIT
Phase B:        R2 DeleteObjects(keys) in chunks of 1000          (no transaction open)
Phase C (tx):   DELETE FROM files WHERE id = ANY($ids) AND status='deleting'
```

- A referrer inserted concurrently blocks on the row lock during Phase A and then fails because `(id, 'active')` no longer exists (**measured**, both orderings). `deleting` rows are invisible to listings and cannot be attached, so there is no window in which a referrer can be created against bytes that are about to disappear.
- Phase B fails → rows stay `deleting`; the nightly sweep retries Phase B + C for every `deleting` row (`DeleteObject` on a missing key is 204, so a half-finished batch retries cleanly). Phase C fails → same. The residual "object gone, row still `deleting`" state is invisible and self-healing; no reconciliation needed for it.
- The pending-file sweep is the same path with the predicate `status='pending' AND created_at < now() - TTL`. `db/maintenance.ts` `sweepTempFiles` is replaced by `retryDeleting()` + this predicate; its "R2 first, row second" order goes away.
- Bounded: ≤ 50 per request, 1000 per sweep batch. No optimistic removal in the UI.

### 6.3 URLs

`fileUrl`: public → `${R2_PUBLIC_URL}/${key}`; private → presigned GET 1 h (S3 endpoint). `downloadUrl`: always presigned, `attachment; filename*=` from `display_name` (`<a download>` is ignored cross-origin). `previewUrl` for documents: presigned, `inline`, opened in a new tab (isolated origin). Presigned URLs are bearer tokens: minted per request, never stored, never logged.

### 6.4 Audit

`tableName: 'files' | 'folders'`; `INSERT`/`UPDATE`/`DELETE`; payload: display name, folder, kind, size, mime, key, status, visibility. One row per file in a batch; the delete audit is written in Phase A (the decision), not Phase C.

### 6.5 Reconciliation (read-only, phase 1)

Weekly from `lib/schedule.ts`, and on demand behind the maintenance token: page `ListObjectsV2` over `m/` in both buckets → keys with no row = `orphanObjects`; rows older than the pending TTL whose key was not listed → `HeadObject` → `danglingRows`. Report only. Purge is phase 3 through `deleteFiles`.

---

## 7. UI / UX (frontend repository, same origin)

**Prerequisite phase:** `hooks/use-upload-file.ts` targets `/api/upload` with fields `file`/`type`, fakes progress, and reads a flat response — three mismatches against the API. `lib/constants/file-types.ts` offers JPEG/HEIC/HEIF; the server admits PNG/WebP/SVG(+PDF) — one allowlist, both repos (`utils/images/config.ts` is already shared by name; the kind table should be too). `components/ui/data-table/client-side-table` is client-side despite its `href` prop and cannot drive `page/perPage/sort/filters`; the media page needs a server-paginated container. Same origin means cookies and CSRF posture are the existing ones; CSP needs `img-src` for the two R2 hosts.

Page `/dash/media`, nav gated on `media.view`, components in `components/media/`:

| Component                                                          | Role                                                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page/index.tsx`                                                   | Container: `?folder=`, `useQueryData`, mutations, `visibilities` from the response                                                                          |
| `toolbar.tsx`                                                      | Breadcrumbs (root shows visibility badges), debounced search with scope toggle, sort, kind filter, New folder (visibility picker at root only), Upload      |
| `folder-grid.tsx`, `file-grid.tsx`                                 | Cards: blurhash → `<img>` for images, kind icon for documents, size, selection, context menu                                                                |
| `upload-queue.tsx`                                                 | Drop target + button; bounded queue of single-file requests; real progress via `XMLHttpRequest`; per-file 429/backoff; refuses disallowed types client-side |
| `details-drawer.tsx`                                               | Preview (`<img>`; documents: "open preview" → presigned inline in a new tab), metadata, copy URL (public only), download, rename, move, used-by, delete     |
| `move-dialog.tsx`                                                  | Folder picker, one level per request, greys out folders of the other visibility                                                                             |
| `new-folder-dialog.tsx`, `rename-dialog.tsx`, `delete-confirm.tsx` | Small forms                                                                                                                                                 |
| `media-picker.tsx`                                                 | Dialog for entity forms; filtered to the purpose's visibility and kinds; browse/search/upload; returns ids                                                  |
| `store.ts`                                                         | zustand: selection, sort                                                                                                                                    |

Deferred UI: list/table view, drag files onto folders, recursive folder delete, linked-files browsing.

---

## 8. Feature triage

### First release

Images (PNG/WebP/SVG) and documents (PDF) · public and private roots · grid view · folders + breadcrumbs · queued multi-file upload with real progress · image preview, document preview in an isolated tab · details with copy URL / download · rename/move · batch delete ≤ 50 · empty-folder delete · name search · media picker for entity forms · RBAC with own-scopes · audit · read-only reconciliation · self-healing `deleting` retry.

### Deferred or omitted

| Feature                                                                                                                        | Status      | Why                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More document types (DOCX/XLSX/PPTX, CSV, TXT)                                                                                 | Per project | Office formats are ZIP containers that need an inner content-type sniff and a macro-variant block; CSV/TXT have no signature. Each needs its own allowlist row with a real check. |
| Embedded PDF preview (iframe)                                                                                                  | Phase 3     | I am not sure a sandboxed cross-origin iframe reliably disables PDF scripting across browsers; new-tab isolation is certain                                                       |
| Recursive folder delete                                                                                                        | Phase 3     | Needs a job or a hard cap; empty-only keeps requests bounded                                                                                                                      |
| List/table view                                                                                                                | Phase 2b    | Needs the server-paginated container                                                                                                                                              |
| Global "linked files" browsing                                                                                                 | Omitted     | Exposes assets of entities the caller cannot view; `usedBy` is permission-filtered instead                                                                                        |
| Trash/restore, versioning                                                                                                      | Omitted     | R2 has no versioning; DB soft-delete later if wanted                                                                                                                              |
| Expiring share links for private files                                                                                         | Phase 3     | Presigned GET exists; needs a UI decision about bearer-token exposure                                                                                                             |
| Locks, comments, per-folder permissions, tags, favourites, content search, video/audio, image editing, zip download, analytics | Omitted     | Out of dashboard scope                                                                                                                                                            |
| Direct-to-R2 / multipart > 12 MiB                                                                                              | Phase 3+    | Cannot validate bytes; needs bucket CORS                                                                                                                                          |

---

## 9. Server-side requirements (for `reports/coolify-deployment.md` when implemented)

- Two buckets; `R2_PUBLIC_URL` = custom domain on the zone for the public bucket, cookie-isolated from the dashboard host; not `r2.dev`.
- Env rules of section 2.5 replace the current "both buckets required" rule.
- No bucket CORS for MVP. Frontend CSP `img-src`: `R2_PUBLIC_URL`, `https://<account>.r2.cloudflarestorage.com`.
- Phase 3: zone-scoped API token for cache purge on public deletes; bucket CORS only if `fetch()`-based download or direct upload is introduced.

---

## 10. Phases and deployment order

**Phase 0 — behaviour-neutral fixes:** `copyFileInR2` percent-encodes `CopySource`; region `auto`; remove the `bucketType as 'public'` cast; cleanup deletes only keys whose put succeeded; `isForeignKeyViolation` recognises 23001.

**Phase 1 — backend:**

1. Migration: enums; `folders`; `files` additions (`status` backfilled from `is_temporary`, `display_name` backfilled then `NOT NULL`, `kind` backfilled `'image'`, `size_bytes` bigint); composite uniques and FKs; drops; `media` in `page_name`; `role_permissions` for system roles.
2. `DASHBOARD_PAGES`, `DEFAULT_PAGE_PERMISSIONS`, env rules.
3. `lib/r2/client.ts`, `lib/media/*`, sweep rewritten onto `retryDeleting`, `claimFiles`.
4. Handlers, `routes.ts` rows (incl. the rename to `/api/upload/file`), messages.
5. Stub extension, tests, OpenAPI regeneration.
6. Reconciliation report + schedule entry.

**Phase 2 — frontend:** prerequisite fixes, then the media page and picker; reference integration into one owner table added to this backend as the worked example (a minimal `demo_assets` table with a direct column and a junction table, kept behind the dev-only route set unless the owner wants it permanent).

**Phase 3:** recursive delete job, reconciliation purge, cache purge, list view, embedded PDF preview, more document types, multipart.

---

## 11. Assumptions and open points

- `DeleteObjects` ≤ 1000 keys and `ListObjectsV2` ≤ 1000 per page — **measured**.
- Not sure whether R2 `CopyObject` has S3's 5 GB single-request ceiling; irrelevant to MVP.
- Caps (500 children, depth 10, 50 per batch, 10 MB documents, 12 MiB body) are dashboard-sized constants, each in one place.
- Same-origin deployment assumed for all frontend statements; if it ever splits, section 7's prerequisite list grows (CORS on the API, cookie `SameSite`, CSP `connect-src`).

---

## 12. Review disposition

### Owner answers (2026-09-04) → plan

| Answer                                            | Landed in                                        |
| ------------------------------------------------- | ------------------------------------------------ |
| Both public and private; how buckets/domains work | 1, 2.5, 3.2 (folder visibility via composite FK) |
| Same origin                                       | 7, 11                                            |
| Arabic messages                                   | 1, 4.2                                           |
| Documents in the first release, allowlist policy  | 1, 4.1, 4.2, 6.1, 8                              |
| Freedom to spike                                  | 13                                               |

### Reviewer points accepted (v2, unchanged unless noted)

Delete order (now three-phase, section 6.2, stronger than v2); ids not keys; opaque keys; client upload queue; `DEFAULT_PAGE_PERMISSIONS` + own scopes; documents off the megapixel budget (own budget on the same route); 412 path and cleanup trap; `bucketType` cast; `display_name` backfill; `scope=all` files only; frontend drift incl. `ClientSideTable`; 1000-key cap measured; SVG/PDF cookie isolation; claim-vs-sweep via status + conditional updates (**measured**); strict FKs + registry, exclusivity dropped; visibility by server policy; `r2.dev`, lifecycle, Bucket Locks/notifications wording, edge cache vs delete, ETag not a hash; **presigned Content-Type finding corrected** (2.3); CORS/CSP; reconciliation in phase 1; `bigint`, folder trigram, normalisation, stable sort, no truncation, no optimistic delete; frontend prerequisite phase; system-role grant.

### Reviewer 2's deletion state machine — now accepted in substance

v2 rejected the `deleting` state in favour of row-first-in-transaction. That design broke the `db/limits.ts` invariant (section 6.0), which I had not read at the time. v3 adopts the state machine: `deleting` marker, R2 outside any transaction, sweep as the retry. What is still not adopted is a queue: the "job" is the request's own continuation plus the nightly retry, which needs no new infrastructure. The TOCTOU that a bare status flag would leave open is closed by the composite FK — a referrer can only ever point at `(id, 'active')` — and that closure is **measured**, not argued.

### Still rejected

- **Keep the old `/api/upload/image` contract:** no working consumer; route renamed to `/api/upload/file` and returns ids.
- **English messages:** product copy in this repository is Arabic; the owner confirmed.
- **Batch delete out of the first release:** same code path as single, one `DeleteObjects` call, now with a self-healing retry.
- **Images-only first release:** the owner wants PDF; it ships behind its own signature check, byte budget and `attachment` disposition on the public bucket.

---

## 13. Spike results (2026-09-04, harness PostgreSQL, scratch tables, file deleted)

Run: `bun tests/helpers/run.ts integration media-spike` → 9 pass, 0 fail (after fixing the classifier, below). Scratch tables `_spike_*` created and dropped inside the test; no schema or migration touched.

| Claim                                                                                                                                                | Result                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Referrer `(file_id, 'active')` → `files(id, status)`: marking a referenced file `deleting`, or deleting it, is refused                               | Refused. SQLSTATE **23001** with `ON UPDATE/DELETE RESTRICT` (`violates RESTRICT setting of foreign key constraint`), constraint name reported.           |
| A referrer cannot be created on a `pending` file                                                                                                     | Refused (23503).                                                                                                                                          |
| Claim (`pending→active`) then referrer insert in one transaction                                                                                     | Succeeds.                                                                                                                                                 |
| Concurrent: mark-deleting held 400 ms, referrer insert started after 50 ms                                                                           | Insert blocked ≥ 400 ms, then refused.                                                                                                                    |
| Concurrent: referrer insert held 400 ms, mark-deleting started after 50 ms                                                                           | Update blocked ≥ 400 ms, then refused.                                                                                                                    |
| Claim vs sweep, both conditional on `status='pending'`, either order                                                                                 | Second statement blocks, then matches 0 rows.                                                                                                             |
| Folder visibility: child with different visibility; move under other-visibility root; file with mismatched bucket; flipping a root that has children | All refused by the composite FKs; matching child and file accepted.                                                                                       |
| `isForeignKeyViolation` recognises the RESTRICT refusal                                                                                              | **No** — it checks 23503 only; 23001 surfaced as a bare Drizzle `Failed query` wrapper. Hence `NO ACTION` in the schema and the phase-0 helper extension. |
| Presigned PUT with `signableHeaders: content-type`, mismatched body header                                                                           | 403 (`X-Amz-SignedHeaders=content-type;host`); SDK default (`host` only) → 200. Cloudflare docs confirmed.                                                |
