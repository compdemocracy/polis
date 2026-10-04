const assert = require("node:assert/strict");
const test = require("node:test");
const wire = require("../voteConvention");

const SEMANTIC = [wire.AGREE, wire.DISAGREE, wire.PASS];

// The frozen numeric wire (P-078 ruling R-wire). This is the one pin of the
// three numbers outside the module itself; every other test names them.
test("the wire is frozen: agree -1, disagree 1, pass 0", () => {
  assert.deepEqual({ ...wire.WIRE }, { AGREE: -1, DISAGREE: 1, PASS: 0 });
  assert.equal(wire.WIRE_AGREE, wire.WIRE.AGREE);
  assert.equal(wire.WIRE_DISAGREE, wire.WIRE.DISAGREE);
  assert.equal(wire.WIRE_PASS, wire.WIRE.PASS);
  assert.ok(Object.isFrozen(wire.WIRE));
});

test("semantic -> wire -> semantic round-trips every vote", () => {
  assert.deepEqual(SEMANTIC, ["agree", "disagree", "pass"]);
  for (const semantic of SEMANTIC) {
    assert.equal(wire.fromWire(wire.toWire(semantic)), semantic);
  }
  assert.equal(wire.toWire(wire.AGREE), wire.WIRE.AGREE);
  assert.equal(wire.toWire(wire.DISAGREE), wire.WIRE.DISAGREE);
  assert.equal(wire.toWire(wire.PASS), wire.WIRE.PASS);
});

test("wire -> semantic -> wire round-trips every wire value", () => {
  for (const value of Object.values(wire.WIRE)) {
    assert.equal(wire.toWire(wire.fromWire(value)), value);
  }
});

test("toWire refuses anything that is not a semantic vote", () => {
  for (const bad of [undefined, null, "", "Agree", "a", "push", "pull", "see", wire.WIRE.AGREE, "constructor"]) {
    assert.throws(() => wire.toWire(bad), /not a vote/);
  }
});

test("fromWire is strict: only the three wire numbers decode", () => {
  for (const bad of [undefined, null, NaN, 2, 0.5, "0", String(wire.WIRE.AGREE), true, false]) {
    assert.equal(wire.fromWire(bad), null);
  }
});

test("isAgree / isDisagree / isPass agree with fromWire", () => {
  for (const value of [...Object.values(wire.WIRE), 2, null, "0"]) {
    assert.equal(wire.isAgree(value), wire.fromWire(value) === wire.AGREE);
    assert.equal(wire.isDisagree(value), wire.fromWire(value) === wire.DISAGREE);
    assert.equal(wire.isPass(value), wire.fromWire(value) === wire.PASS);
  }
});

test("the a/d/p letter decoder (famous and ptptoi vectors)", () => {
  assert.equal(wire.fromLetter("a"), wire.AGREE);
  assert.equal(wire.fromLetter("d"), wire.DISAGREE);
  assert.equal(wire.fromLetter("p"), wire.PASS);
  assert.equal(wire.LETTER_UNSEEN, "u");
  for (const bad of ["u", "A", "x", "", undefined, null, "constructor", "toString"]) {
    assert.equal(wire.fromLetter(bad), null);
  }
  // A whole vector decodes to wire numbers through the semantic names.
  const vector = "adpu";
  const decoded = [...vector].map(wire.fromLetter).map((s) => (s ? wire.toWire(s) : null));
  assert.deepEqual(decoded, [wire.WIRE.AGREE, wire.WIRE.DISAGREE, wire.WIRE.PASS, null]);
});

test("comments are placed on the agree side of the wire axis", () => {
  assert.equal(wire.COMMENT_PLACEMENT_SIGN, wire.WIRE.AGREE);
});
