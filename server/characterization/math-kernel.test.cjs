"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { valid, compareKernels, recordingKernel } = require("./math-kernel.cjs");
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
