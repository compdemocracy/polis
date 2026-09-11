"use strict";
const { canonical } = require("./core.cjs");
function valid(k) {
  if (
    !k ||
    k.schema !== "polis-math-kernel/1" ||
    typeof k.system !== "string" ||
    typeof k.machine !== "string" ||
    !Array.isArray(k.observed) ||
    k.observed.length < 1 ||
    k.observed.length > 2
  )
    return false;
  if (
    !["Linux/x86_64", "Linux/aarch64", "Darwin/arm64"].includes(
      k.system + "/" + k.machine
    )
  )
    return false;
  const linux = k.system === "Linux" && k.machine === "x86_64";
  if (k.requested !== (linux ? "Haswell" : "not-forced")) return false;
  const prefixes = k.observed.map((r) => r.prefix);
  if (
    new Set(prefixes).size !== prefixes.length ||
    !prefixes.includes("libopenblas") ||
    prefixes.some((p) => !["libopenblas", "libscipy_openblas"].includes(p)) ||
    (linux && prefixes.length !== 2)
  )
    return false;
  return k.observed.every(
    (r) =>
      r.internal_api === "openblas" &&
      r.num_threads === 1 &&
      typeof r.version === "string" &&
      typeof r.architecture === "string" &&
      r.architecture.length > 0 &&
      (!linux || r.architecture.toLowerCase() === "haswell")
  );
}
function compareKernels(recorded, fresh) {
  const known = valid(recorded) && valid(fresh);
  return {
    recorded: recorded || null,
    fresh: fresh || null,
    status: !known
      ? "UNKNOWN_OR_INVALID"
      : canonical(recorded) === canonical(fresh)
      ? "MATCH"
      : "MISMATCH",
  };
}
function recordingKernel(run, seed) {
  if (
    !valid(run.mathKernel) ||
    canonical(run.mathKernel) !== canonical(seed.kernel)
  )
    return null;
  return run.mathKernel;
}
module.exports = { valid, compareKernels, recordingKernel };
