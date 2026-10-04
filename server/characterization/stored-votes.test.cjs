"use strict";
// P-078 PR-G: the baseline's stored votes (cases 0528-0531) are compared by
// meaning through the baseline's sign declaration, never by their raw sign.
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { readRecording, pin } = require("./recording.cjs");
const {
  baselineDeclaration,
  comparable,
  firstDifference,
  recordingConvention,
  recordingConventionArtifact,
  RECORDING_CONVENTION,
  STORED_VOTE_TABLES,
  STORED_VOTE_FIELD,
} = require("./compare.cjs");
const { readVote, seedVote } = require("./seed-vote.cjs");
const root = require("./baseline.cjs").testBaseline();
const baseline = readRecording(root);
const declared = baselineDeclaration();
const flipped = -declared.storage_agree_value;

function storedRows(c) {
  return declared.stored_vote_tables.flatMap((t) =>
    ["added", "removed"].flatMap((side) => c.effects.db[t]?.[side] || [])
  );
}
function mirrored(c) {
  const copy = structuredClone(c);
  for (const row of storedRows(copy))
    if (row.vote !== null && row.vote !== undefined)
      row.vote = seedVote(
        readVote(row.vote, declared.storage_agree_value),
        flipped
      );
  return copy;
}

test("the declaration names exactly the cases that record stored votes", () => {
  const withVotes = baseline.cases
    .map((c, i) => [baseline.index.cases[i].path, c])
    .filter(([, c]) => storedRows(c).some((r) => "vote" in r));
  assert.deepEqual(
    Object.fromEntries(withVotes.map(([p, c]) => [p, c.caseId])),
    declared.cases
  );
});

for (const [casePath, caseId] of Object.entries(declared.cases)) {
  const c = baseline.cases.find((x) => x.caseId === caseId);
  test(`${casePath} ${caseId}: an agree, stored as the declaration says`, () => {
    const rows = storedRows(c);
    assert(rows.length > 0);
    for (const row of rows)
      assert.equal(row.vote, seedVote("agree", declared.storage_agree_value));
    for (const row of storedRows(comparable(c, declared.storage_agree_value)))
      assert.equal(row.vote, "agree");
    // Without a convention the comparator compares raw values, as before.
    assert.deepEqual(storedRows(comparable(c)), rows);
  });
  test(`${casePath}: the same request under the other convention is the same case`, () => {
    assert.equal(
      firstDifference(c, mirrored(c), {
        expected: declared.storage_agree_value,
        actual: flipped,
      }),
      null
    );
  });
  test(`${casePath}: a changed vote still differs under either convention`, () => {
    for (const actual of [declared.storage_agree_value, flipped]) {
      const changed = structuredClone(c);
      // a disagree, stored at the convention the actual side declares
      storedRows(changed)[0].vote = seedVote("disagree", actual);
      assert.match(
        firstDifference(c, changed, {
          expected: declared.storage_agree_value,
          actual,
        }),
        /\.vote$/
      );
    }
  });
}

test("the committed baseline states no convention of its own, so the companion applies", () => {
  assert(!fs.existsSync(path.join(root, RECORDING_CONVENTION)));
  assert.deepEqual(recordingConvention(root), {
    storageAgreeValue: declared.storage_agree_value,
    source: "artifacts/baseline.sign.json",
  });
  assert.deepEqual(declared.stored_vote_tables, STORED_VOTE_TABLES);
  assert.equal(declared.stored_vote_field, STORED_VOTE_FIELD);
});

function withRecordingCopy(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p078-recording-"));
  try {
    fs.cpSync(root, tmp, { recursive: true });
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function writeSidecar(dir, artifact, { indexed }) {
  fs.writeFileSync(
    path.join(dir, RECORDING_CONVENTION),
    JSON.stringify(artifact)
  );
  if (!indexed) return;
  const file = path.join(dir, "index.json"),
    index = JSON.parse(fs.readFileSync(file));
  index.files.push(pin(dir, RECORDING_CONVENTION));
  fs.writeFileSync(file, JSON.stringify(index));
}

test("review witness: an unindexed +1 sidecar beside the baseline is refused, never a MATCH", () => {
  const c = baseline.cases.find(
    (x) => x.caseId === Object.values(declared.cases)[0]
  );
  withRecordingCopy((dir) => {
    writeSidecar(dir, recordingConventionArtifact(flipped), { indexed: false });
    assert.throws(() => recordingConvention(dir), /P078_CONVENTION_REFUSED/);
  });
  // Had it been honoured, the inverted rows would have compared equal.
  assert.equal(
    firstDifference(mirrored(c), c, {
      expected: flipped,
      actual: declared.storage_agree_value,
    }),
    null
  );
});

test("an indexed vote-convention.json is honoured at either convention (a re-record)", () => {
  for (const value of [declared.storage_agree_value, flipped])
    withRecordingCopy((dir) => {
      writeSidecar(dir, recordingConventionArtifact(value), { indexed: true });
      assert.deepEqual(recordingConvention(dir), {
        storageAgreeValue: value,
        source: RECORDING_CONVENTION,
      });
    });
});

test("an indexed sidecar that no longer matches its index entry is refused", () => {
  withRecordingCopy((dir) => {
    writeSidecar(
      dir,
      recordingConventionArtifact(declared.storage_agree_value),
      {
        indexed: true,
      }
    );
    fs.writeFileSync(
      path.join(dir, RECORDING_CONVENTION),
      JSON.stringify(recordingConventionArtifact(flipped))
    );
    assert.throws(() => recordingConvention(dir), /does not match its index/);
  });
  withRecordingCopy((dir) => {
    writeSidecar(
      dir,
      { ...recordingConventionArtifact(1), storage_agree_value: 0 },
      { indexed: true }
    );
    assert.throws(() => recordingConvention(dir), /-1 or \+1/);
  });
  assert.throws(() => recordingConventionArtifact(2), /-1 or \+1/);
});

test("a recording with no indexed convention, other than the committed baseline, compares raw", () => {
  withRecordingCopy((dir) => {
    const file = path.join(dir, "index.json"),
      index = JSON.parse(fs.readFileSync(file));
    index.meta.note = "not the committed baseline";
    fs.writeFileSync(file, JSON.stringify(index));
    assert.equal(recordingConvention(dir), null);
  });
});

test("without conventions a mirrored case differs (raw comparison is unchanged)", () => {
  const c = baseline.cases.find(
    (x) => x.caseId === Object.values(declared.cases)[0]
  );
  assert.match(firstDifference(c, mirrored(c)), /\.vote$/);
});
