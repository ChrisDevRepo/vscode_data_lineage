// Exit-status contract between gate steps and the gate summary.

/** Exit status a gate step uses when it could not run its comparison and reports SKIP. */
export const SKIP_EXIT_CODE = 77;

/** Whether the process runs under continuous integration, where a skipped comparison is a checkout defect rather than a local limitation. */
export function isCi(env = process.env) {
  const value = (env.CI ?? '').trim().toLowerCase();
  return value !== '' && value !== 'false' && value !== '0';
}

/** Classifies a finished gate step by its exit status. */
export function stepOutcome(status) {
  if (status === 0) return 'PASS';
  if (status === SKIP_EXIT_CODE) return 'SKIP';
  return 'FAIL';
}

/** Retains the child's output or records its command and termination details when none was captured. */
export function stepFailureOutput(step, run) {
  if (run.output.trim()) return run.output;
  return `No output captured.\nCommand: ${JSON.stringify([step.cmd, ...step.args])}\n`
    + `Exit status: ${run.status ?? 'none'}\n`
    + (run.signal ? `Signal: ${run.signal}\n` : '')
    + (run.error ? `Spawn error: ${run.error.message}\n` : '');
}
