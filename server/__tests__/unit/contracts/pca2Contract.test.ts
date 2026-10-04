// pca2/1: the schema documents what GET /api/v3/math/pca2 serves today. It
// must validate every recorded pca2 response body in the characterization
// baseline (read-only; the bodies are read straight from the archive, nothing
// is replayed), the zero-vote structure, and a generated fixture.

import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { Value } from "@sinclair/typebox/value";
import { Pca2 } from "../../../src/contracts/pca2";
import {
  SERVER_ROOT,
  ajvValidator,
  clientValidate,
  committedSchema,
  subsetSchema,
} from "./contractHelpers";

const schema = committedSchema("pca2");
const ajvFull = ajvValidator(schema);
const ajvSubset = ajvValidator(subsetSchema(schema));

function check(value: unknown, subset: boolean) {
  const viaAjv = subset ? ajvSubset(value) : ajvFull(value);
  const viaClient = clientValidate(schema, value, subset);
  return {
    ajv: viaAjv,
    client: viaClient,
    typebox: subset ? null : Value.Check(Pca2, value),
  };
}

// createEmptyPcaStructure (server/src/utils/pca.ts): the canonical zero-vote
// document, every field present.
const emptyStructure = () => ({
  "group-clusters": [],
  "base-clusters": { x: [], y: [], id: [], count: [], members: [] },
  "group-votes": {},
  "group-aware-consensus": {},
  "user-vote-counts": {},
  "in-conv": [],
  "n-cmts": 0,
  pca: {
    comps: [[], []],
    center: [],
    "comment-extremity": [],
    "comment-projection": {},
  },
  tids: [],
  n: 0,
  repness: {},
  consensus: { agree: [], disagree: [] },
  "votes-base": {},
  lastModTimestamp: null,
  lastVoteTimestamp: 1759492800000,
  "comment-priorities": {},
  math_tick: 0,
});

const generatedFixture = () => ({
  "group-clusters": [
    { id: 0, center: [0.5, -0.25], members: [0, 1] },
    { id: 1, center: [-0.5, 0.25], members: [2] },
  ],
  "base-clusters": {
    x: [0.4, 0.6, -0.5],
    y: [-0.2, -0.3, 0.25],
    id: [0, 1, 2],
    count: [2, 1, 3],
    members: [[1, 2], [3], [4, 5, 6]],
  },
  "group-votes": {
    "0": { votes: { "0": { A: 2, D: 1, S: 3 } }, "n-members": 3 },
    "1": { votes: { "0": { A: 0, D: 3, S: 3 } }, "n-members": 3 },
  },
  "group-aware-consensus": { "0": 0.12 },
  "user-vote-counts": { "1": 1, "2": 1 },
  "in-conv": [1, 2, 3, 4, 5, 6],
  "n-cmts": 1,
  n: 6,
  pca: {
    comps: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    center: [0, 0],
    "comment-extremity": [0.7],
    "comment-projection": [[0.1], [0.2]],
  },
  tids: [0],
  repness: { "0": [{ tid: 0, "repful-for": "agree", "p-success": 0.66 }] },
  consensus: { agree: [], disagree: [{ tid: 0 }] },
  lastModTimestamp: null,
  lastVoteTimestamp: 1759492800000,
  math_tick: 7,
});

describe("pca2/1 schema", () => {
  test("is versioned by $id", () => {
    expect(schema.$id).toBe("pca2/1");
  });

  test.each([
    ["the zero-vote structure", emptyStructure],
    ["a generated fixture", generatedFixture],
  ])("validates %s", (_name, build) => {
    const result = check(build(), false);
    expect(result.ajv.errors).toEqual([]);
    expect(result.client.errors).toEqual([]);
    expect(result.typebox).toBe(true);
  });

  test.each<[string, (v: any) => void]>([
    ["math_tick as a label string", (v) => (v.math_tick = "python-7")],
    ["vote counts without S", (v) => delete v["group-votes"]["0"].votes["0"].S],
    ["group-clusters as an object", (v) => (v["group-clusters"] = {})],
    ["missing base-clusters", (v) => delete v["base-clusters"]],
    ["a repness entry without a tid", (v) => delete v.repness["0"][0].tid],
  ])("rejects %s", (_name, mutate) => {
    const value = generatedFixture();
    mutate(value);
    const result = check(value, false);
    expect([result.ajv.valid, result.client.valid, result.typebox]).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("a ?keys= subset validates against the subset form only", () => {
    const subset = { tids: [0, 1], "n-cmts": 2 };
    expect(check(subset, true).ajv.valid).toBe(true);
    expect(check(subset, true).client.valid).toBe(true);
    expect(check(subset, false).ajv.valid).toBe(false);
    expect(check(subset, false).client.valid).toBe(false);
    expect(check({ tids: "0,1" }, true).ajv.valid).toBe(false);
    expect(check({ tids: "0,1" }, true).client.valid).toBe(false);
  });
});

// --- the recorded characterization baseline --------------------------------

type Recorded = {
  id: string;
  target: string;
  status: number;
  body: Buffer;
  subset: boolean;
};

function bytes(
  chunks: Array<{ bytes: { base64: string } }> | undefined
): Buffer {
  return Buffer.concat(
    (chunks || []).map((c) => Buffer.from(c.bytes.base64, "base64"))
  );
}

function recordedPca2(): Recorded[] {
  const archive = path.join(
    SERVER_ROOT,
    "characterization",
    "artifacts",
    "baseline.json.gz"
  );
  const files: Record<string, string> = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(archive)).toString()
  );
  const out: Recorded[] = [];
  for (const name of Object.keys(files)) {
    if (!name.endsWith("/request.json")) continue;
    const request = JSON.parse(files[name]);
    const target = Buffer.from(request.target.base64, "base64").toString();
    if (!target.startsWith("/api/v3/math/pca2")) continue;
    const response = JSON.parse(
      files[name.replace("/request.json", "/response.json")]
    );
    let body = bytes(response.body);
    const encoding = (response.headers || []).find(
      (h: any) => h.name.toLowerCase() === "content-encoding"
    );
    if (encoding && encoding.value === "gzip" && body.length > 0)
      body = zlib.gunzipSync(body);
    const requestBody = bytes(request.body).toString();
    const query = new URLSearchParams(target.split("?")[1] || "");
    let bodyKeys = false;
    try {
      bodyKeys = requestBody.length > 0 && "keys" in JSON.parse(requestBody);
    } catch {
      bodyKeys = false;
    }
    out.push({
      id: request.request_id,
      target,
      status: response.status,
      body,
      subset: query.has("keys") || bodyKeys,
    });
  }
  return out;
}

describe("pca2/1 against the recorded characterization baseline", () => {
  const recorded = recordedPca2();
  const slice = recorded.filter((r) => r.id.includes("/pca2/"));

  test("the baseline holds the 336-request pca2 slice", () => {
    expect(slice).toHaveLength(336);
  });

  test("every recorded 200 body validates (full document, or the subset form for ?keys=)", () => {
    const failures: string[] = [];
    let full = 0;
    let subsetOnly = 0;
    let zeroVote = 0;
    const required: string[] = schema.required;
    for (const r of recorded.filter((x) => x.status === 200)) {
      const value = JSON.parse(r.body.toString());
      // A ?keys= request is held to the subset form; any body that carries
      // every required key (a full document) is held to the full schema.
      const isFull = required.every((k) => k in value);
      if (!r.subset) expect(isFull).toBe(true);
      const result = check(value, !isFull);
      if (
        !result.ajv.valid ||
        !result.client.valid ||
        result.typebox === false
      ) {
        failures.push(
          `${r.id} ${r.target}: ${[
            ...result.ajv.errors,
            ...result.client.errors,
          ].join("; ")}`
        );
      }
      if (isFull) full++;
      else subsetOnly++;
      if (isFull && value.n === 0) zeroVote++;
    }
    expect(failures).toEqual([]);
    // Counts as recorded at the time of writing; a re-recorded baseline that
    // changes them should be read, not silently accepted.
    expect({ full, subsetOnly }).toEqual({ full: 100, subsetOnly: 120 });
    expect(zeroVote).toBeGreaterThan(0);
  });

  test("every recorded 304 has an empty body and every 400 is not a pca2 document", () => {
    const statuses: Record<number, number> = {};
    for (const r of recorded)
      statuses[r.status] = (statuses[r.status] || 0) + 1;
    expect(statuses).toEqual({ 200: 220, 304: 84, 400: 40 });
    for (const r of recorded.filter((x) => x.status === 304))
      expect(r.body.length).toBe(0);
    for (const r of recorded.filter((x) => x.status === 400)) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(r.body.toString());
      } catch {
        parsed = null;
      }
      expect(parsed === null || !ajvFull(parsed).valid).toBe(true);
    }
  });
});
