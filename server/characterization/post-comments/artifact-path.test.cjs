"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { artifactDirectory } = require("./artifact-path.cjs");

test("the quoted invalid-vote case has an upload-safe directory", () => {
  const name = '100-vote-invalid-"bad"';
  assert.equal(artifactDirectory(name), "100-vote-invalid-%22bad%22");
  assert.equal(decodeURIComponent(artifactDirectory(name)), name);
});

test("upload-forbidden characters and path separators round-trip safely", () => {
  for (const character of ['"', ":", "<", ">", "|", "*", "?", "\r", "\n", "/", "\\"]) {
    const name = "case-" + character;
    const directory = artifactDirectory(name);
    assert.match(directory, /^[A-Za-z0-9_%~-]+$/);
    assert.equal(decodeURIComponent(directory), name);
  }
});

test("encoding is distinct from literal escapes and preserves Unicode", () => {
  const names = ['case-"', "case-%22", "case-%2522", "case-/", "case-%2F", "case-😀", "case-é"];
  const directories = names.map(artifactDirectory);
  assert.equal(new Set(directories).size, names.length);
  assert.deepEqual(directories.map(decodeURIComponent), names);
});

test("plain names stay readable and dot segments cannot traverse directories", () => {
  assert.equal(artifactDirectory("concurrent-unique-0"), "concurrent-unique-0");
  for (const name of [".", "..", "../outside", "trailing. "]) {
    const directory = artifactDirectory(name);
    assert.match(directory, /^[A-Za-z0-9_%~-]+$/);
    assert.equal(decodeURIComponent(directory), name);
  }
});
