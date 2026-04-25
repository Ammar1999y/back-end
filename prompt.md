Act as a senior backend engineer, security architect, and database architect
with 15+ years of experience designing, reviewing, and auditing
production-grade REST APIs and database schemas for large-scale systems. Adopt a
critical, security-first, detail-oriented mindset. Assume all endpoints are
exposed to the public internet and all schemas are deployed in a high-traffic,
real-world environment where security, performance, correctness, reliability,
and scalability are paramount. Provide feedback with the depth and
responsibility expected from a professional conducting a production security and
code review.

---

I want you to review and analyze the provided API endpoint(s) and any related
database schema.
The only API endpoints you need to read are under the folder @app/api/dash/ & @app/api/auth/ 
and the database schema @db/schema.ts  
@db/migrations/001_add_trgm_indexes.sql  
Please perform a thorough evaluation and provide a structured report that
includes:

---

Before writing the report, perform a silent internal analysis pass in this exact
order:

1. 🔴 First, scan the entire code for **security vulnerabilities only** (OWASP
   API Top 10, auth, IDOR, injection, exposure, mass assignment)
2. 🔴 Second, scan for **race conditions and concurrency issues only**
   (read-modify-write, missing transactions, isolation levels, locking,
   duplicate submissions, idempotency)
3. 🟠 Third, scan for **performance bottlenecks** (N+1, missing indexes,
   inefficient queries, over-fetching, unnecessary round-trips, missing
   pagination, caching)
4. 🟡 Fourth, scan for **data integrity and correctness issues** (null safety,
   boundary conditions, business logic correctness, soft deletes, timestamps)
5. 🟡 Fifth, scan for **database schema issues** (design flaws, missing
   constraints, missing CHECK constraints, data types, naming, indexing
   strategy)
6. 🟢 Finally, note **code quality, error handling, and maintainability**
   concerns

Only after completing all passes, write the structured report.

**Critical rule:** Never let a low-priority issue (variable naming, code style)
cause you to overlook a high-priority one (security flaw, race condition). If
you are uncertain whether something is a security issue — report it.

---

## **1. Security Vulnerabilities**

Identify any security risks. All endpoints must comply with the **OWASP API Top
10**:

- **Authentication & Authorization** — Is every endpoint properly protected? Is
  there missing auth middleware? Could a user access another user's data (IDOR)?
- **Input Validation** — Is all input strictly schema-validated at the boundary
  (type, format, length, range, enum)? Are allowlists and parameterized queries
  used instead of blanket sanitization? Could malformed input cause crashes or
  unintended behavior?
- **Injection Prevention** — Is there any risk of SQL injection, NoSQL
  injection, or command injection?
- **Rate Limiting & Abuse** — Are sensitive endpoints (login, register, OTP,
  password reset) protected against brute force and abuse?
- **Data Exposure** — Are sensitive fields (passwords, tokens, internal IDs)
  ever leaked in responses?
- **Mass Assignment** — Are only explicitly allowed fields accepted? Could a
  user send unexpected fields that overwrite protected values?

---

## **2. Race Conditions & Concurrency**

Evaluate how the code handles concurrent requests:

- **Read-Modify-Write patterns** — Identify any place where data is read,
  modified in code, then written back. These are race condition risks. The logic
  must be pushed to the database instead.

  Bad pattern:

```ts
const user = await db.select().from(users).where(eq(users.id, id));
const newBalance = user.balance - 100;
await db.update(users).set({ balance: newBalance }).where(eq(users.id, id));
```

  Correct pattern:

```ts
const result = await db
  .update(users)
  .set({ balance: sql`${users.balance} - 100` })
  .where(and(eq(users.id, userId), gte(users.balance, 100)))
  .returning();

if (result.length === 0) throw new Error("Insufficient balance");
```

- **Missing transactions** — Are multiple related DB operations wrapped in a
  transaction? A partial failure must not leave the state inconsistent.
- **Transaction Isolation Level** — Is the isolation level appropriate for the
  use case? Could phantom reads or non-repeatable reads cause incorrect
  behavior?
- **Locking** — Should `FOR UPDATE` or `FOR SHARE` be used to prevent
  concurrent modification of the same row?
- **Duplicate submissions** — Could a user submit the same request twice quickly
  and get double the effect (double charge, double entry, etc.)?
- **Idempotency** — Are non-idempotent operations (payments, transfers, etc.)
  protected with idempotency keys?

---

## **3. Performance & Efficiency**

Evaluate the efficiency of each endpoint:

- **N+1 Queries** — Are there loops that fire individual DB queries per item
  instead of one batched query?
- **Missing indexes** — Based on the query patterns used, are appropriate
  indexes likely to exist? Flag queries filtering on non-indexed fields. Before
  recommending an index, assess how frequently it would realistically be used —
  skip indexes that would only be queried rarely if the write overhead is not
  justified.
- **Inefficient query patterns** — Flag uses of `COUNT(*) > 0` or fetching rows
  just to check existence; use `EXISTS` instead. Identify cases where a raw SQL
  query would be clearer and more optimal than the ORM abstraction (e.g., window
  functions, CTEs, bulk operations, complex RETURNING clauses).
- **Over-fetching** — Does the code select `*` or fetch entire rows when only a
  few fields are needed?
- **Unnecessary DB round-trips** — Can multiple queries be merged into one? Are
  there sequential awaits that could run in parallel with `Promise.all`?
- **Pagination** — Are all list endpoints paginated? Could they return unbounded
  results?
- **Caching opportunities** — Is any data fetched repeatedly that could be
  cached?

---

## **4. Data Integrity & Correctness**

Assess whether the logic correctly handles edge cases:

- **Missing null/undefined checks** — Could a missing or null value cause silent
  failures or wrong behavior?
- **Boundary conditions** — Are numeric limits, string lengths, and array sizes
  validated?
- **Business logic correctness** — Does the endpoint enforce business rules at
  the database level where possible (e.g., constraints, CHECK constraints)
  rather than only in app code?
- **Soft deletes** — If soft delete is used, are queries correctly filtering out
  deleted records?
- **Timestamp handling** — Are `created_at` / `updated_at` managed correctly and
  consistently?

---

## **5. Database Schema & Constraints**

Evaluate the database schema related to the reviewed endpoints:

- **Schema design** — Are there design flaws that compromise scalability or
  performance? Is the normalization / denormalization balance appropriate?
- **Constraints** — Are PK, FK, UNIQUE, and CHECK constraints applied where
  needed? Are there missing constraints that could allow invalid data?
- **CHECK constraints** — Are enum-like columns and value ranges enforced via
  CHECK at the database level, not just application-level validation? Where
  possible, are these expressed using Drizzle ORM's `.check()` API so they are
  part of the schema definition and compiled into migration SQL?
- **Data types** — Are appropriate, bounded data types used? Is `varchar(n)`
  used with appropriate length limits based on expected content? Is `text` only
  used when content is genuinely unbounded?
- **Naming conventions** — Is naming consistent and descriptive across all
  tables and columns?
- **Indexing strategy** — Do appropriate indexes exist for the query patterns
  used? Are there missing indexes that would impact performance?
- **Security at schema level** — Are there any security vulnerabilities at the
  schema level (e.g., storing sensitive data in plaintext)?

> Note: Application-level validation with Zod is already in place. Database
> constraints serve as an additional safety layer — a last line of defense if
> data ever bypasses the application (e.g., direct DB access, scripts, or bugs).

---

## **6. Error Handling & Response Quality**

Evaluate how the endpoint behaves under failure:

- **Unhandled exceptions** — Could any uncaught error leak a stack trace or
  internal details to the client?
- **Meaningful error messages** — Are errors returned in a consistent,
  client-friendly format?
- **HTTP status codes** — Are the correct status codes used (401 vs 403, 404 vs
  400, etc.)?
- **Partial failure handling** — If part of a multi-step operation fails, is the
  state left consistent?

---

## **7. Code Quality & Maintainability**

Review the structure and clarity of the code:

- **Separation of concerns** — Is business logic mixed with routing/controller
  logic?
- **Code duplication** — Is the same logic repeated across endpoints that could
  be extracted?
- **Magic values** — Are hardcoded numbers or strings used where named constants
  would be clearer?
- **Readability** — Would a new developer understand this endpoint without
  documentation?

---

## **8. Production Readiness & Expert Insights**

Apply professional judgment. Flag anything that:

- Could become a serious problem under load or at scale
- Represents a subtle security risk not covered above
- Could cause data corruption or inconsistency in edge cases
- Represents hidden technical debt that will be painful to fix later
- Is a pattern that seems fine now but breaks with multiple server instances
  (horizontal scaling)
- Represents a design decision that limits future features
- Is missing audit / logging mechanisms where they should exist
- Needs versioning strategies for API or data evolution
- Should consider partitioning / sharding for future scale
- Has missing constraints or indexes for production use
- Contains risky patterns or anti-patterns
- Does not support smooth migration and schema evolution

Even if not explicitly requested.

---

Assume these endpoints are deployed in a **production-grade application**
serving real users.

Focus your analysis on (highest to lowest priority):

1. **Security**
2. **Reliability & correctness under concurrency**
3. **Performance at scale**
4. **Scalability**
5. **Maintainability**

---

## **Output Format Requirements**

Generate your response as a well-structured **Markdown (md) document**.

The document should:

- Use clear headings and subheadings
- Be easy to read for a developer with ~1 year of backend experience
- Avoid overly academic language
- Explain **why** something is a problem
- Explain **what could happen if ignored** (e.g., "a user could drain another
  user's balance", "two concurrent requests could both pass the balance check")
- Suggest **how to fix it** with a concrete code example where possible
- Prioritize issues by severity: 🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low
- Tag each issue with a **scale indicator** to show when it becomes relevant:
  - 🧪 **Early Stage** — Not a real concern yet with few users; a simpler solution exists now, but flag the future risk so it's not forgotten
  - 📈 **At Scale** — Only becomes a real problem under high traffic or with many users (e.g., N+1 queries, missing indexes, race conditions under load)
  - ⚠️ **Always** — Critical regardless of traffic or user count (e.g., auth bypasses, SQL injection, data exposure)

  For **Early Stage** issues: briefly mention the simpler approach that works now, then explain what breaks when traffic or users grow.
  For **At Scale** issues: give a rough sense of when it starts to hurt (e.g., "noticeable above ~10k rows", "problematic with concurrent requests").
Write the report as if advising a competent developer who understands backend
concepts but is not a security or concurrency specialist.

---

Provide your response as a **clear technical report** with explanations and
concrete recommendations. Update the file  @reports/claude-sonnet.md   for the report.

---

Issues you should ignore:
@reports/should-ignore.md