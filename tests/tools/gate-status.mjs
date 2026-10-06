// Exit-status contract between gate steps and the gate summary.

/**
 * Exit status a gate step uses when it could not run its comparison and reports SKIP.
 *
 * @remarks
 * Distinct from 0 so the gate summary shows SKIP instead of PASS. 77 is the conventional
 * "test skipped" status of Automake-style harnesses.
 */
export const SKIP_EXIT_CODE = 77;

/**
 * Whether the process runs under continuous integration, where a skipped comparison is a
 * checkout defect rather than a local limitation.
 *
 * @param env - Environment to read; defaults to the process environment.
 * @returns `true` when `CI` is set to anything other than empty, `false` or `0`.
 */
export function isCi(env = process.env) {
  const value = (env.CI ?? '').trim().toLowerCase();
  return value !== '' && value !== 'false' && value !== '0';
}

/**
 * Classifies a finished gate step by its exit status.
 *
 * @param status - Exit status; `null` when the step was killed by a signal.
 * @returns `PASS` for 0, `SKIP` for {@link SKIP_EXIT_CODE}, otherwise `FAIL`.
 */
export function stepOutcome(status) {
  if (status === 0) return 'PASS';
  if (status === SKIP_EXIT_CODE) return 'SKIP';
  return 'FAIL';
}
