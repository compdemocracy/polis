"use strict";
// Preserve completed results; a failed observation never reruns or skips a case.
async function executeCases(planned, run, observed, phase) {
  const results = [];
  let fatal = null;
  for (let i = 0; i < planned.length; i++) {
    let actual;
    try {
      actual = await run(planned[i]);
    } catch (error) {
      fatal = {
        caseId: planned[i].caseId,
        phase: phase(),
        code:
          error.message === "SNAPSHOT_DNS_RETRY_EXHAUSTED"
            ? error.message
            : "CASE_EXECUTION_FAILED",
      };
      // The cause goes to this run's own log only, never into results.json, so
      // a stopped run says why (a lost database connection, a full disk) and
      // not only where.
      console.error(
        `${fatal.code} ${fatal.caseId} ${fatal.phase}: ${
          error?.code ? error.code + " " : ""
        }${String(error?.message ?? error).slice(0, 300)}`
      );
      break;
    }
    results.push(actual);
    if (observed(actual, i)) break;
  }
  return { results, fatal };
}
module.exports = { executeCases };
