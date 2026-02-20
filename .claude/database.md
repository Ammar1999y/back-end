Act as a senior database architect with 15+ years of experience designing,
reviewing, and optimizing schemas for large-scale production systems.

Adopt a critical, detail-oriented mindset. Assume the schema may be deployed in
a high-traffic, real-world environment where reliability, performance,
scalability, and security are crucial.

Provide feedback with the depth, caution, and responsibility expected from an
experienced professional conducting a production readiness review.

---

I want you to review and analyze the provided database schema file.

This schema represents the **initial design** of the application's database.

Please perform a thorough evaluation and provide a structured report that
includes:

---

## **1. Potential Limitations**

Identify possible weaknesses such as:

- Design flaws
- Scalability concerns
- Performance risks
- Data integrity issues
- Security vulnerabilities

---

## **2. Best Practice Compliance**

Evaluate adherence to best practices:

- Normalization / denormalization balance
- Indexing strategy
- Constraints (PK, FK, UNIQUE, CHECK, etc.)
- Naming conventions
- Suitability of data types

---

## **3. Production Readiness**

Assess readiness for real-world deployment:

- Missing constraints or indexes
- Risky patterns or anti-patterns
- Migration / schema evolution challenges
- Multi-user / concurrency considerations

---

## **4. Improvement Suggestions**

Provide actionable recommendations:

- Structural optimizations
- Index recommendations
- Refactoring ideas
- Performance enhancements
- Maintainability improvements

---

## **5. Optional Enhancements**

Suggest useful advanced features if applicable:

- Audit / logging mechanisms
- Soft delete patterns
- Versioning strategies
- Partitioning / sharding considerations

---

## **6. Independent Expert Insights**

Apply your own professional judgment.

Identify anything that:

- Could become a problem at scale
- Might limit future features
- Could be redesigned for robustness
- Represents a hidden technical debt

Even if not explicitly requested.

---

Assume the schema is intended for a **production-grade application**.

Focus your analysis on:

- Reliability
- Performance
- Scalability
- Security
- Maintainability

---

## **Output Format Requirements**

Generate your response as a well-structured **Markdown (md) document**.

The document should:

- Use clear headings and subheadings
- Be easy to read for a developer with ~1 year of database experience
- Avoid overly academic or DBA-only language
- Explain issues in a practical, understandable way
- Explain **why** something is a problem
- Explain **what could happen if ignored**
- Suggest **how to fix it**
- Include examples where helpful

Write the report as if advising a competent developer who understands core
concepts but is not a database specialist.

## **Additional Review Constraints**

When analyzing data types and constraints, apply the following specific
guidelines:

**Data Types:**

- Flag any `text` columns and recommend replacing them with `varchar(n)` using
  an appropriate length limit based on the expected content (e.g.,
  `varchar(255)` for names/emails, `varchar(512)` for URLs, `varchar(1000)` for
  short descriptions). Only keep `text` if the content is genuinely unbounded.

**CHECK Constraints (prefer database-level enforcement):**

- Recommend CHECK constraints at the database level wherever applicable, not
  just application-level validation.
- Examples to look for:
  - **Password fields:** if stored (e.g., hashed), enforce a minimum length via
    CHECK (e.g., `CHECK (LENGTH(password_hash) >= 50)`) since a proper
    bcrypt/argon2 hash is always long.
  - **Email fields:** add a basic format CHECK (e.g.,
    `CHECK (email ~* '^[^@]+@[^@]+\.[^@]+$')`).
  - **Enum-like columns:** enforce allowed values via CHECK instead of relying
    solely on application logic.
- Where possible, express these constraints using **Drizzle ORM's `.check()`
  API** so they are part of the schema definition and get compiled into the
  migration SQL — not just runtime validation. The goal is real
  database-enforced constraints, not only Zod/application-layer checks.

> Note: Application-level validation with Zod is already in place. The database
> constraints are an additional safety layer — a last line of defense if data
> ever bypasses the application (e.g., direct DB access, scripts, or bugs).

**Index Usage Warnings:**

- If you recommend adding an index, explicitly assess how frequently that index
  would realistically be used.
- Flag any index that would only be queried rarely or exclusively by
  background/cron jobs. For such cases, note that the index maintenance overhead
  on writes may not justify the read performance gain, and suggest skipping it
  or making it optional.

---

Provide your response as a **clear technical report** with explanations and
concrete recommendations. Creact an md file for the report.

---
