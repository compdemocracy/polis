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
      break;
    }
    results.push(actual);
    if (observed(actual, i)) break;
  }
  return { results, fatal };
}
module.exports = { executeCases };
