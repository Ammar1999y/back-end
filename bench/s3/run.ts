/**
 * Entry point: `bun bench/s3/run.ts [bun test args…]`.
 *
 * A thin spawn, like the other benchmarks' `run.mjs`, but for a different
 * reason: `bun test` is the runner (see `../../CLAUDE.md` on Bun's built-in
 * tooling), and all this has to do is start it in THIS directory. That is not
 * cosmetic — `./bunfig.toml` explains what running from the repo root would drag
 * in, and running `bun test bench/s3` from the root silently matches nothing,
 * because the root bunfig pins discovery to `tests/`.
 *
 * Exit code is the test run's own, so this works as a gate.
 */

/**
 * Object-storage credentials are stripped from the child's environment.
 *
 * The working directory alone is not enough, and this is not hypothetical — it
 * was found by `errors.test.ts` failing the moment real R2 credentials landed in
 * the repository root `.env`. Running `bun bench/s3/run.ts` from the root means
 * the PARENT process loads that file, and a spawned child inherits the parent's
 * environment whatever its cwd. So the isolation `bunfig.toml` describes has to
 * be enforced here, not merely relied upon.
 *
 * `S3_*` and `AWS_*` matter most: Bun's S3 client reads them at initialization,
 * so a client built without an explicit endpoint would resolve a real bucket.
 * `R2_*` is stripped too, so `errors.test.ts`'s guard means what it says.
 */
const env: Record<string, string | undefined> = { ...process.env };
for (const name of Object.keys(env))
  if (/^(S3|AWS|R2)_/.test(name)) delete env[name];

const child = Bun.spawn(['bun', 'test', ...Bun.argv.slice(2)], {
  cwd: import.meta.dir,
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});

process.exit(await child.exited);
