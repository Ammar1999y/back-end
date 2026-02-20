Act as a senior backend engineer and security architect with 15+ years of
experience designing, reviewing, and auditing production-grade REST APIs. Adopt
a critical, security-first mindset. Assume the endpoints are exposed to the
public internet in a high-traffic, real-world environment where security,
performance, correctness, and reliability are paramount. Provide feedback with
the depth and responsibility expected from a professional conducting a
production security and code review.

---

I want you to review and analyze the provided API endpoint(s).

Please perform a thorough evaluation and provide a structured report that
includes:

---

Before writing the report, perform a silent internal analysis pass in this exact
order:

1. 🔴 First, scan the entire code for **security vulnerabilities only** (auth,
   IDOR, injection, exposure)
2. 🔴 Second, scan for **race conditions and concurrency issues only**
   (read-modify-write, missing transactions, duplicate submissions)
3. 🟠 Third, scan for **performance bottlenecks** (N+1, missing pagination,
   unnecessary queries)
4. 🟡 Fourth, scan for **data integrity and correctness issues**
5. 🟢 Finally, note **code quality and maintainability** concerns

Only after completing all passes, write the structured report.

**Critical rule:** Never let a low-priority issue (variable naming, code style)
cause you to overlook a high-priority one (security flaw, race condition). If
you are uncertain whether something is a security issue — report it.

---

## **1. Security Vulnerabilities**

Identify any security risks such as:

- **Authentication & Authorization** — Are endpoints properly protected? Is
  there missing auth middleware? Could a user access another user's data (IDOR)?
- **Input Validation** — Is all input validated and sanitized before use? Could
  malformed input cause crashes or unintended behavior?
- **Injection Risks** — Is there any risk of SQL injection, NoSQL injection, or
  command injection?
- **Rate Limiting & Abuse** — Are sensitive endpoints (login, register, OTP,
  password reset) protected against brute force or abuse?
- **Data Exposure** — Are sensitive fields (passwords, tokens, internal IDs)
  ever leaked in responses?
- **Mass Assignment** — Could a user send unexpected fields that overwrite
  protected values?

---

## **2. Race Conditions & Concurrency**

Evaluate how the code handles concurrent requests:

- **Read-Modify-Write patterns** — Identify any place where data is read,
  modified in code, then written back. These are race condition risks. Example
  of a risky pattern:

```ts
const user = await db.select().from(users).where(eq(users.id, id));
const newBalance = user.balance - 100;
await db.update(users).set({ balance: newBalance }).where(eq(users.id, id));
```

Suggest pushing the logic to the database instead:

```ts
const result = await db.update(users)
  .set({ balance: sql`${users.balance} - 100` })
  .where(and(eq(users.id, userId), gte(users.balance, 100)))
  .returning();

if (result.length === 0) throw new Error("Insufficient balance");
```

- **Missing transactions** — Are multiple related DB operations wrapped in a
  transaction? What happens if one step fails mid-way?
- **Transaction Isolation Level** — Is the isolation level appropriate for the
  use case? Could phantom reads or non-repeatable reads cause incorrect
  behavior?
- **Optimistic vs Pessimistic Locking** — Should `FOR UPDATE` or `FOR SHARE` be
  used to prevent concurrent modification of the same row?
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
  indexes likely to exist? Flag queries filtering on non-indexed fields.
- **Inefficient query patterns** — Flag uses of `COUNT(*) > 0` or fetching rows
  just to check existence; use `EXISTS` instead. Identify cases where a raw SQL
  query would be clearer and more optimal than the ORM abstraction (e.g., window
  functions, CTEs, bulk operations, complex RETURNING clauses).
- **Over-fetching** — Does the code select `*` or fetch entire rows when only a
  few fields are needed?
- **Unnecessary DB round-trips** — Can multiple queries be merged into one? Are
  there sequential awaits that could run in parallel with `Promise.all`?
- **Pagination** — Are list endpoints paginated? Could they return unbounded
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

## **5. Error Handling & Response Quality**

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

## **6. Code Quality & Maintainability**

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

## **7. Independent Expert Insights**

Apply your own professional judgment. Flag anything that:

- Could become a serious problem under load or at scale
- Represents a subtle security risk not covered above
- Could cause data corruption or inconsistency in edge cases
- Represents hidden technical debt that will be painful to fix later
- Is a pattern that seems fine now but breaks with multiple server instances
  (horizontal scaling)

Even if not explicitly requested.

---

Assume these endpoints are deployed in a **production-grade application**
serving real users.

Focus your analysis on:

- **Security** (highest priority)
- **Correctness under concurrency**
- **Performance at scale**
- **Reliability and fault tolerance**
- **Maintainability**

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

Write the report as if advising a competent developer who understands backend
concepts but is not a security or concurrency specialist.

---

Provide your response as a **clear technical report** with explanations and
concrete recommendations. Create an md file for the report.

---
