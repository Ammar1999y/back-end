# Security & Architecture Audit Report

This document outlines the findings of a rigorous, production-grade security, concurrency, and architecture audit targeting the dashboard API constraints (`@app/api/dash/`), authentication layer (`@app/api/auth/`), and related database schemas. The findings are prioritized by severity and tagged with scale indicators.

---

## **1. Security Vulnerabilities**

### 🔴 **Critical: Information Exposure Configures a User Enumeration Vector**
🧪 **Always** | *Location: `auth/otp/send/handler.ts`*

**The Problem:**
To prevent attackers from enumerating valid emails or phone numbers, the OTP send endpoint attempts to return a spoofed generic response (`GENERIC_SEND_DATA`) if a user is not found. However, this disguise is completely broken because the `attemptsRemaining` parameter is static (`OTP_MAX_ATTEMPTS - 1`). When hitting an _existing_ user incrementally, `processOtpSend` operates correctly, counting down the attempts. An attacker only needs to submit the target credential twice: if the attempt count drops, the account exists. If it stays at the static maximum minus one, it does not.

**The Impact:**
Complete bypass of anti-enumeration defenses, allowing attackers to harvest valid emails and phone numbers for targeted phishing, credential stuffing, or targeted harassment.

**The Fix:**
Stop returning attempt limits or specific error structures conditionally on existence. Strip `attemptsRemaining` from the response entirely for all requests (valid or invalid), and rely exclusively on generic "If the information matches our records, a code has been sent" message shapes without mathematical tells. If countdowns are required by design, a cache must simulate countdowns deterministically for non-existent identifiers.

### 🟠 **High: Missing `checkPasswordCompromise` Gate During Admin User Creation**
⚠️ **Always** | *Location: `dash/users/handler.ts` (POST)*

**The Problem:**
When administrators edit a user's password (`PUT /users/[id]`), the system correctly queries external datasets (`await checkPasswordCompromise(password)`) to prevent the usage of known compromised passwords. However, during the initial creation of a user (`POST /users`), this check is entirely missing.

**The Impact:**
Administrators or automated provisioning flows can inadvertently assign weak or publicly pwned passwords to new employees or users, leaving those fresh accounts highly vulnerable to immediate credential stuffing or brute forcing.

**The Fix:**
Import and seamlessly invoke the guard inside the `POST` handler before generating the argon2 hash boundary.
```ts
import { checkPasswordCompromise } from '@/lib/auth/check-password';

// ... inside POST ...
if (validatedData.password) {
  await checkPasswordCompromise(validatedData.password);
}
const hashedPassword = await hashPassword(validatedData.password);
```

---

## **2. Race Conditions & Concurrency** 

### 🟡 **Medium: Lack of Pessimistic Locking on OTP Initial Verification Checks**
📈 **At Scale** | *Location: `auth/otp/verify/handler.ts`, `auth/otp/send/handler.ts`*

**The Problem:**
In both the OTP send and OTP verify endpoints, the code queries the user (`await db.select({ id: users.id }).from(users).where(...).limit(1)`) to verify existence and gather the user ID independently from the subsequent actions (`processOtpVerify` / `processOtpSend`). Because this select is done without `FOR SHARE` locks or inside an encapsulating transaction, highly concurrent requests against the same IP or network trigger a Time-Of-Check to Time-Of-Use (TOCTOU) condition where rate limits or user active states can shift between read and the write execution.

**The Impact:**
Possibility for an attacker to rapidly submit verification payloads concurrently, squeezing through the validation layer and multiplying the intended amount of processing calls before the limits catch up on the `verificationSessions` table. 

**The Fix:**
Drive the logic downward into a single cohesive transaction wrapper. Alternatively, pass the query into the internal utility natively so it can execute the lookup inside its `withTransaction` blocks using `FOR SHARE`.

---

## **3. Performance & Efficiency**

### 🟠 **High: Pagination Sorting Relies on Inappropriate Index Structure**
📈 **At Scale** | *Location: `dash/users/[id]/handler.ts` (GET)*

**The Problem:**
When fetching an administrator's view of a user's `sessions`, the system limits the query to active sessions using an efficient bounding box:
```ts
.where(and(eq(sessions.userId, targetId), gt(sessions.expiresAt, sql`now()`)))
.orderBy(desc(sessions.createdAt))
```
While `idx_sessions_user_expires` (`userId`, `expiresAt`) serves the `WHERE` clauses efficiently, PostgreSQL cannot magically pivot an index tuned for `expiresAt` limits into achieving a `createdAt` descending sort. 

**The Impact:**
At high scale (if a user generates thousands of historical sessions and the retention strategy expands), PostgreSQL will aggressively trigger an in-memory `Sort` node or a disk-spilling external merge sort after scanning the index to fulfill the page structure.

**The Fix:**
Since you are always hitting `userId`, and creating a secondary `order by` on `createdAt`, create an additional supporting index if viewing sessions becomes heavily frequented:
```sql
CREATE INDEX idx_sessions_user_created ON sessions (user_id, created_at DESC);
```

---

## **4. Data Integrity & Correctness**

### 🔴 **Critical: Destructive Soft-Delete Evades Database Audit Trails**
⚠️ **Always** | *Location: `dash/users/[id]/handler.ts` (DELETE)*

**The Problem:**
During user deletion, the system correctly obfuscates standard PII and nullifies `phoneNumber` to free up the unique database constraints. However, the `lockedUser` snapshot retrieved prior to this mutation specifically omits selecting the `phoneNumber` in its columns map. As a result, the subsequent invocation of `auditLog` provides an `oldData` payload entirely devoid of the user's phone number.

**The Impact:**
An irrecoverable loss of historical data. If a user is deleted and later engaged in a fraud investigation, the application retains no traceable historic record of what their phone number was—both the user table and the audit table have been thoroughly scrubbed of this data column.

**The Fix:**
Include `phoneNumber: users.phoneNumber` inside your initial `for('update')` selection mask, and append it to the `oldData` payload parameter inside `auditLog`.

### 🟡 **Medium: "Ghost Updates" upon External Exception Flow**
🧪 **Early Stage** | *Location: `dash/users/me/change-email/handler.ts`*

**The Problem:**
Changing a user's email commits an active database transaction correctly, mutating their core identifier. However, _after_ the transaction completes, an un-`catch`'d external API boundary (`await auth.api.getSession(...)`) attempts to purge cookie cache synchronously.

**The Impact:**
If Better Auth's internals fault, or the local session provider timeouts, the application will drop into `catch (error)` block and return an HTTP `500 MSG_UPDATE_ERROR` back to the UI. The user assumes the email modification failed, yet the database irrevocably bound the change. The UI and DB are actively desynchronized mentally for the user causing login disruptions.

**The Fix:**
Wrap the exterior call inside an isolated `try/catch` specifically designed to swallow (or log out) the error, ensuring the successful API response block processes uninterrupted.

---

## **5. Database Schema & Constraints**

### 🟢 **Low: Implicit Check Constraint Fallthroughs in Error Handling**
🧪 **Early Stage** | *Location: `dash/users/me/change-email/handler.ts`*

**The Problem:**
The database enforces a case sanity check via `check('chk_email_lowercase', sql'email = LOWER(email)')`. If an input somehow bypasses Zod's internal schemas and touches the database sequentially capitalized, PostgreSQL aborts the transaction with a `check_violation`. 
Currently, the catch blocks trap `isUniqueViolation` (and occasionally `isForeignKeyViolation`). A check constraint violation slips to the fallback `handleApiError` rendering a raw `500` HTTP status rather than a controlled `400 Bad Request`.

**The Impact:**
Bad UX tracking anomalies where API boundaries are bypassed (such as mobile apps or external integrations failing to lowercase data) generating high severity 500 dumps rather than clean 400 validations.

**The Fix:**
Include a `isCheckViolation(error)` trap function alongside unique/foreign checks, capturing the named constraint arrays.

---

## **6. Code Quality & Maintainability**

### 🟢 **Low: Inverted Sub-query for Cross-Role Session Invalidations**
📈 **At Scale** | *Location: `dash/permissions/[id]/handler.ts` (PUT)*

**The Problem:**
When forcefully locking or deactivating a generalized role (such as 'Standard User'), the code fetches an array of matching internal users across an `IN ()` constraint boundary:
```ts
await tx.delete(sessions).where(inArray(sessions.userId, tx.select({ id: users.id }).from(users).where(...)));
```
**The Impact:**
If an active role containing 50,000 users is forcibly terminated, generating a sub-query expansion mapping 50,000 bounds into `inArray` can paralyze the PostgreSQL query planner cache boundaries causing lock contention on the sessions table. 

**The Fix:**
Consider utilizing PostgreSQL's native `USING` joins within queries to perform scalable destructive batch actions seamlessly or delegate asynchronous queueing for batch deletion chunks if user scales expand dramatically.
