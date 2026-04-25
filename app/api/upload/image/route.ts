/* 
`upload/image` uses `Buffer` and reads `rawRequest.formData()` — breaks on Elysia / Edge runtimes

Two compounding portability breaks in the same handler:

1. `Buffer.from(await entry.arrayBuffer())` — `Buffer` is Node-only; Edge/Bun crash with `ReferenceError`.
2. `ctx.rawRequest.formData()` — works on Next because the Next adapter only consumes the body when `Content-Type: application/json`. On Elysia, the framework parser consumes multipart first, leaving the stream drained; `formData()` throws `Body has already been used` — which the `.catch` silently converts to a generic 400 "noFiles".

**Fix (combined):** Parse multipart at the adapter layer and pass a standard `FormData` through the contract. Add to `HandlerInput`:

Pre-parsed multipart form when Content-Type is multipart/form-data. 
```ts
formData: FormData | null;
```
Populate in Next/Hono via `request.formData()` when appropriate; on Elysia either configure `parse: 'none'` for upload routes and call `ctx.request.formData()`, or coerce Elysia's parsed object back to `FormData`. Replace buffer code with `Uint8Array`:

```ts
if (!ctx.formData) throw new CustomError(uploadMsg.noFiles, HTTP_STATUS.BAD_REQUEST);
const entries = ctx.formData.getAll('files');
const bytes = new Uint8Array(await entry.arrayBuffer());
```

Ensure `validateMagicBytes` iterates typed arrays. No `rawRequest` or `Buffer` dependency remains.
*/

import { toNextHandler } from '@/lib/http/adapters/next';

import * as handlers from './handler';

export const POST = toNextHandler(handlers.POST);
