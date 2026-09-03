/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun audit`, retried only when the registry itself failed.
 *
 * npm's bulk advisories endpoint returns 5xx often enough to fail a run on its
 * own — a 503 on 2026-09-04 failed CI on a commit whose dependencies had not
 * changed, and the same outage blocks the pre-push gate. What makes this
 * non-trivial is that a REAL advisory also exits non-zero: retrying every
 * failure would turn a genuine finding into three slow attempts and still
 * report it, so the retry is gated on the transport signature below and any
 * other failure is passed through on the first attempt.
 *
 * Usage: `bun scripts/audit.ts` — the `audit` package.json script, the CI job
 * and the lefthook gate all go through here so there is one implementation.
 */

/**
 * A registry that could not answer, as opposed to one that answered "vulnerable".
 * Bun prints the former as `error: POST <url> - <status>` and the latter as a
 * report, so the status class is the whole discriminator; the socket names cover
 * a connection that never got far enough to produce one.
 */
const TRANSPORT_FAILURE =
  /error: (?:GET|POST) https?:\/\/\S+ - (?:408|425|429|5\d\d)\b|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|SocketClosed|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/;

const ATTEMPTS = 3;
const BACKOFF_MS = 15_000;

async function runAudit(): Promise<{ code: number; output: string }> {
  const audit = Bun.spawn(['bun', 'audit'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(audit.stdout).text(),
    new Response(audit.stderr).text(),
    audit.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const { code, output } = await runAudit();
  process.stdout.write(output);
  if (code === 0) process.exit(0);

  if (!TRANSPORT_FAILURE.test(output)) process.exit(code === 0 ? 1 : code);

  if (attempt === ATTEMPTS) {
    console.error(
      `The advisories registry failed ${ATTEMPTS} times. This is the registry, not this repository — re-run the job.`
    );
    process.exit(1);
  }
  console.error(
    `Registry transport failure on attempt ${attempt} of ${ATTEMPTS}; retrying in ${BACKOFF_MS / 1000}s.`
  );
  await Bun.sleep(BACKOFF_MS * attempt);
}
