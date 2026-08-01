@.claude/skills/backend/SKILL.md
@.claude/skills/caveman/SKILL.md
@CLAUDE.md 

**First, for clarification:**
This will serve as a **starter kit** for most upcoming projects, meaning there is no real data yet — but it will be heavily relied upon going forward.

Act as a principal backend engineer performing a hostile audit of an API endpoint.

Target: 
@app/api/dash/ 
@app/api/auth/ 

Before judging anything, read the FULL call chain: route, handler, every
imported helper, validation schemas, DB schema + relevant migrations, and any
shared flow code. Never review the handler in isolation.

Baseline: the attached backend skill. Treat it as a floor, not a checklist —
report any real issue even if the skill doesn't name it, and flag places where
following a skill rule would itself cause a problem in this specific endpoint.

Audit every dimension:
- Security: authn/authz, IDOR, injection, enumeration/timing oracles, rate
  limiting, data exposure, mass assignment
- Concurrency: races, TOCTOU, lock usage/order, transaction boundaries,
  partial-failure consistency
- Correctness: edge cases, null/boundary handling, idempotency, soft-delete
  filtering
- Performance: N+1, unbounded queries, unnecessary round-trips, whether the
  indexes the queries need actually exist
- Error handling: leaks, status codes, response consistency
- Maintainability: duplication, misplaced logic, dead code, readability

Rules of evidence:
- Every finding cites file:line and a concrete failure scenario
  (inputs/state → wrong outcome). No ungrounded hypotheticals.
- Before reporting a finding, actively try to refute it against the code;
  drop anything you can't defend.
- Code marked with a TODO or an explanatory comment is a known/deliberate
  decision — list it separately as "acknowledged", not as a defect.
- Severity per finding: Critical / High / Medium / Low / Nit. Rank by severity.

Output — report only, change nothing:
1. One-paragraph verdict.
2. Findings table: severity | file:line | issue | failure scenario | suggested fix.
3. Short detail section per finding.
4. "Checked and clean" list — what you verified and found sound, so absence
   of findings is meaningful.



---

Update the file  @reports/claude-fable.md  for the report.

---

Issues you should ignore:
@reports/should-ignore.md