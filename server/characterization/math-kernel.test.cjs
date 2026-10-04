"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  valid,
  compareKernels,
  recordingKernel,
  replayKernelAdmitted,
} = require("./math-kernel.cjs");
const identity = () => ({
  schema: "polis-math-kernel/1",
  system: "Linux",
  machine: "x86_64",
  requested: "Haswell",
  observed: ["libopenblas", "libscipy_openblas"].map((prefix) => ({
    prefix,
    internal_api: "openblas",
    architecture: "Haswell",
    version: "fixture",
    num_threads: 1,
  })),
});
test("matching requested and observed identities admit", () => {
  assert.ok(valid(identity()));
  assert.equal(compareKernels(identity(), identity()).status, "MATCH");
  assert.deepEqual(
    recordingKernel({ mathKernel: identity() }, { kernel: identity() }),
    identity()
  );
});
for (const [name, mutate] of [
  ["absent request", (x) => delete x.requested],
  ["unforced Linux", (x) => (x.requested = "not-forced")],
  ["ignored request", (x) => (x.observed[1].architecture = "SkylakeX")],
  ["extra threads", (x) => (x.observed[0].num_threads = 2)],
  ["missing backend", (x) => x.observed.pop()],
  ["duplicate backend", (x) => (x.observed[1] = x.observed[0])],
  ["wrong API", (x) => (x.observed[0].internal_api = "unknown")],
])
  test(name + " refuses eligibility", () => {
    const x = identity();
    mutate(x);
    assert.equal(valid(x), false);
    assert.equal(compareKernels(identity(), x).status, "UNKNOWN_OR_INVALID");
  });
test("older archive metadata is explicitly unknown", () => {
  assert.equal(recordingKernel({}, {}), null);
  assert.equal(compareKernels(null, identity()).status, "UNKNOWN_OR_INVALID");
});
test("library runtime difference is a mismatch, never tolerance", () => {
  const x = identity();
  x.observed[0].version = "changed";
  assert.equal(compareKernels(identity(), x).status, "MISMATCH");
});
test("archive run and seed evidence must agree", () => {
  const x = identity();
  x.observed[0].version = "changed";
  assert.equal(
    recordingKernel({ mathKernel: identity() }, { kernel: x }),
    null
  );
});
test("ARM records native unforced observation explicitly", () => {
  const x = identity();
  x.system = "Darwin";
  x.machine = "arm64";
  x.requested = "not-forced";
  x.observed.forEach((r) => (r.architecture = "armv8"));
  assert.ok(valid(x));
  assert.equal(compareKernels(x, x).status, "MATCH");
});

test("unknown platform refuses", () => {
  const x = identity();
  x.system = "unknown";
  x.requested = "not-forced";
  assert.equal(valid(x), false);
});
test("native Darwin may report only NumPy OpenBLAS", () => {
  const x = identity();
  x.system = "Darwin";
  x.machine = "arm64";
  x.requested = "not-forced";
  x.observed = [x.observed[0]];
  x.observed[0].architecture = "armv8";
  assert.ok(valid(x));
});
const arm = () => {
  const x = identity();
  x.machine = "aarch64";
  x.requested = "not-forced";
  x.observed.forEach((r) => (r.architecture = "armv8"));
  return x;
};
test("x86_64 against x86_64 stays exact: any identity change is refused", () => {
  const x = identity();
  x.observed[0].version = "changed";
  for (const env of [{}, { P027_CROSS_PLATFORM_REPLAY: "1" }]) {
    assert.equal(
      replayKernelAdmitted(compareKernels(identity(), x), env),
      false
    );
    assert.equal(
      replayKernelAdmitted(compareKernels(identity(), identity()), env),
      true
    );
  }
});
test("a different platform is CROSS_PLATFORM, refused unless explicitly requested", () => {
  for (const [recorded, fresh] of [
    [identity(), arm()],
    [arm(), identity()],
  ]) {
    const k = compareKernels(recorded, fresh);
    assert.equal(k.status, "CROSS_PLATFORM");
    assert.equal(replayKernelAdmitted(k, {}), false);
    assert.equal(
      replayKernelAdmitted(k, { P027_CROSS_PLATFORM_REPLAY: "true" }),
      false
    );
    assert.equal(
      replayKernelAdmitted(k, { P027_CROSS_PLATFORM_REPLAY: "1" }),
      true
    );
  }
});
test("the cross-platform request never admits an invalid or same-platform mismatch", () => {
  const env = { P027_CROSS_PLATFORM_REPLAY: "1" };
  const changed = arm();
  changed.observed[0].version = "changed";
  assert.equal(compareKernels(arm(), changed).status, "MISMATCH");
  assert.equal(
    replayKernelAdmitted(compareKernels(arm(), changed), env),
    false
  );
  const unforced = identity();
  unforced.requested = "not-forced";
  assert.equal(
    replayKernelAdmitted(compareKernels(unforced, arm()), env),
    false
  );
  assert.equal(replayKernelAdmitted(compareKernels(null, arm()), env), false);
});
