// delphi-job-result/1: generated fixtures for every state and every family
// validate, and the contract's state rules reject what they must. Three
// validators must agree: ajv on the committed schema, the dependency-free
// client-report validator, and TypeBox's own checker on the source.

import { describe, expect, test } from "@jest/globals";
import { Value } from "@sinclair/typebox/value";
import {
  DELPHI_FAMILIES,
  DelphiJobResult,
} from "../../../src/contracts/delphiJobResult";
import {
  ajvValidator,
  clientValidate,
  committedSchema,
  familiesPartitioned,
  generatedEnvelopes,
  nineStateEnvelopes,
  readyWithOnly,
} from "./contractHelpers";

const schema = committedSchema("delphiJobResult");
const ajv = ajvValidator(schema);

function verdicts(value: unknown) {
  return {
    ajv: ajv(value).valid,
    client: clientValidate(schema, value, false).valid,
    typebox: Value.Check(DelphiJobResult, value),
  };
}

function expectValid(value: unknown) {
  const result = ajv(value);
  expect(result.errors).toEqual([]);
  expect(clientValidate(schema, value, false).errors).toEqual([]);
  expect(verdicts(value)).toEqual({ ajv: true, client: true, typebox: true });
}

function expectInvalid(value: unknown) {
  expect(verdicts(value)).toEqual({
    ajv: false,
    client: false,
    typebox: false,
  });
}

const clone = (v: unknown): any => JSON.parse(JSON.stringify(v));

describe("delphi-job-result/1 schema", () => {
  test("is versioned by $id", () => {
    expect(schema.$id).toBe("delphi-job-result/1");
  });

  describe.each(Object.entries(generatedEnvelopes()))(
    "state %s",
    (_state, envelope) => {
      test("validates", () => expectValid(envelope));
      test("partitions the families between outputs and omitted", () => {
        expect(familiesPartitioned(envelope)).toBe(true);
      });
    }
  );

  describe.each(Object.entries(nineStateEnvelopes()))(
    "recorded state %s",
    (_state, envelope) => {
      test("validates as a generated fixture", () => expectValid(envelope));
    }
  );

  test.each([...DELPHI_FAMILIES])(
    "family %s validates on its own (?families=)",
    (family) => {
      const envelope = readyWithOnly(family);
      expectValid(envelope);
      expect(familiesPartitioned(envelope)).toBe(true);
    }
  );

  const ready = () => clone(generatedEnvelopes().ready);
  const running = () => clone(generatedEnvelopes().running);
  const failed = () => clone(generatedEnvelopes().failed);
  const pending = () => clone(generatedEnvelopes().pending);
  const empty = () => clone(generatedEnvelopes().empty);

  const rejected: Array<[string, () => any]> = [
    [
      "another contract version",
      () => ({ ...ready(), contract_version: "delphi-job-result/2" }),
    ],
    ['status "error" inside a body', () => ({ ...ready(), status: "error" })],
    ["an unknown envelope key", () => ({ ...ready(), runs: {} })],
    [
      "as_of without a time zone",
      () => ({ ...ready(), as_of: "2023-11-14T19:20:01.000000" }),
    ],
    ["a ready envelope with an attempt", () => ({ ...ready(), attempt: 1 })],
    [
      "an unknown family in outputs",
      () => ({ ...ready(), outputs: { report_data: "{}" } }),
    ],
    [
      "a family listed twice in omitted",
      () => ({ ...ready(), omitted: ["umap", "umap"] }),
    ],
    [
      "an unknown family in omitted",
      () => ({ ...ready(), omitted: ["available_tables"] }),
    ],
    [
      "pending with outputs",
      () => ({ ...pending(), outputs: { umap: { nodes: [] } } }),
    ],
    [
      "pending missing a family in omitted",
      () => ({ ...pending(), omitted: DELPHI_FAMILIES.slice(1) }),
    ],
    ["running at attempt 0", () => ({ ...running(), attempt: 0 })],
    [
      "running with a failure",
      () => ({ ...running(), failure: failed().failure }),
    ],
    ["failed without a failure", () => ({ ...failed(), failure: null })],
    [
      "failed with an open failure code",
      () => {
        const f = failed();
        f.failure.code = "error";
        return f;
      },
    ],
    [
      "failed carrying log text",
      () => {
        const f = failed();
        f.failure.message = "Traceback (most recent call last)";
        return f;
      },
    ],
    [
      "empty with a job id",
      () => ({ ...empty(), job_id: "0000a001-0000-4000-8000-000000000001" }),
    ],
    ["empty that is pinned", () => ({ ...empty(), pinned: true })],
    [
      "a topic without member_tids",
      () => {
        const r = ready();
        delete r.outputs.topics_by_layer["0"][0].member_tids;
        return r;
      },
    ],
    [
      "a topic with a string cluster id",
      () => {
        const r = ready();
        r.outputs.topics_by_layer["0"][0].cluster_id = "0";
        return r;
      },
    ],
    [
      "a valid narrative without parsed",
      () => {
        const r = ready();
        r.outputs.narratives.group_informed_consensus.parsed = null;
        return r;
      },
    ],
    [
      "an invalid narrative with parsed text",
      () => {
        const r = ready();
        const key = Object.keys(r.outputs.narratives)[1];
        r.outputs.narratives[key].parsed = { paragraphs: [] };
        return r;
      },
    ],
    [
      "an invalid narrative with an open reason",
      () => {
        const r = ready();
        const key = Object.keys(r.outputs.narratives)[1];
        r.outputs.narratives[key].invalid_reason = "jsonrepair";
        return r;
      },
    ],
    [
      "a narrative serving its raw text",
      () => {
        const r = ready();
        r.outputs.narratives.group_informed_consensus.report_data = "{}";
        return r;
      },
    ],
    [
      "a citation that is not a tid",
      () => {
        const r = ready();
        r.outputs.narratives.group_informed_consensus.parsed.paragraphs[0].sentences[0].clauses[0].citations =
          ["0"];
        return r;
      },
    ],
    [
      "a umap node carrying comment text",
      () => {
        const r = ready();
        r.outputs.umap.nodes[0].comment_text = "participant text";
        return r;
      },
    ],
    [
      "a visualization without a layer",
      () => {
        const r = ready();
        delete r.outputs.visualizations[0].layer_id;
        return r;
      },
    ],
    [
      "a statement without its inputs",
      () => {
        const r = ready();
        delete r.outputs.collective_statements[0].inputs;
        return r;
      },
    ],
    [
      "topic stats without seen",
      () => {
        const r = ready();
        delete Object.values<any>(r.outputs.topic_stats)[0].seen;
        return r;
      },
    ],
    [
      "consensus inputs without repness",
      () => {
        const r = ready();
        delete r.outputs.consensus_inputs.repness;
        return r;
      },
    ],
    [
      "inputs without prompt versions",
      () => {
        const r = ready();
        delete r.inputs.prompt_version;
        return r;
      },
    ],
  ];

  test.each(rejected)("rejects %s", (_name, build) => expectInvalid(build()));

  test("the generated topic stats define seen as agree + disagree + pass", () => {
    for (const envelope of Object.values(nineStateEnvelopes())) {
      for (const entry of Object.values<any>(
        envelope.outputs.topic_stats || {}
      )) {
        expect(entry.seen).toBe(entry.agree + entry.disagree + entry.pass);
      }
    }
  });

  test("a zero-vote ready root carries the math families present and empty", () => {
    const zero = nineStateEnvelopes().zero_vote;
    expect(zero.omitted).not.toContain("consensus_inputs");
    expect(zero.omitted).not.toContain("topic_stats");
    for (const map of Object.values<any>(zero.outputs.consensus_inputs)) {
      expect(Object.keys(map)).toHaveLength(0);
    }
  });
});
