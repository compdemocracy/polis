"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const clock = require("./clock.cjs");
test("step clock changes Date, leaves native timers, and resets the replay default", async () => {
  const native = Date,
    timer = setTimeout;
  const restore = clock.install();
  try {
    assert.equal(Date.now(), clock.instant);
    clock.set("1700000010007");
    assert.equal(Date.now(), 1700000010007);
    assert.equal(new Date().getTime(), Date.now());
    assert.equal(new Date(123).getTime(), 123);
    assert.equal(setTimeout, timer);
    const before = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(performance.now() > before);
    assert.equal(Date.now(), 1700000010007);
    for (const bad of ["NaN", "-1", "1.5", "", "8640000000000001", "1, 2"]) {
      assert.throws(() => clock.set(bad));
      assert.equal(Date.now(), 1700000010007);
    }
    clock.set(null);
    assert.equal(Date.now(), clock.instant);
  } finally {
    restore();
  }
  assert.equal(Date, native);
});
