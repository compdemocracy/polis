// The legacy Delphi read-route recordings (server/characterization/delphi,
// nine states on generated fixtures), lifted into delphi-job-result/1
// envelopes, must validate. This is the shape check for what the job routes
// and the legacy adapters will serve: every value the legacy routes record
// today has a place, with the right type, in the contract.
//
// The lift below is test code, not the adapter. Fields the legacy routes do
// not record (the captured math snapshot, prompt versions, attempt numbers)
// get the null a legacy import carries, or attempt 1. The topic_stats and
// consensus_inputs families come from the captured math, which no legacy
// route serves, so they are listed in `omitted`.
//
// The recordings land with the Delphi recordings PR; until they are present
// this suite reports itself skipped. DELPHI_RECORDINGS_DIR points it at
// another copy.

import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";
import Ajv from "ajv";
import {
  DELPHI_FAMILIES,
  NarrativeDocument,
} from "../../../src/contracts/delphiJobResult";
import { schemaDocument } from "../../../src/contracts/generate";
import {
  SERVER_ROOT,
  ajvValidator,
  clientValidate,
  committedSchema,
  familiesPartitioned,
} from "./contractHelpers";

const RECORDINGS =
  process.env.DELPHI_RECORDINGS_DIR ||
  path.join(SERVER_ROOT, "characterization", "delphi", "recordings");
const present = fs.existsSync(
  path.join(RECORDINGS, "completed", "delphi.json")
);

const schema = committedSchema("delphiJobResult");
const ajv = ajvValidator(schema);
const documentValid = new Ajv().compile(schemaDocument(NarrativeDocument));

function body(state: string, file: string): any {
  const recording = JSON.parse(
    fs.readFileSync(path.join(RECORDINGS, state, `${file}.json`), "utf8")
  );
  expect(recording.response.status).toBe(200);
  return JSON.parse(recording.response.body);
}

const iso = (t: string | null) =>
  t === null ? null : /(Z|[+-]\d{2}:\d{2})$/.test(t) ? t : `${t}Z`;
const jobOf = (topicKey: string) => topicKey.split("#")[0];

function narrative(entry: any) {
  const raw = entry.report_data;
  const common = {
    model: entry.model,
    created_at: iso(entry.timestamp),
    source_topic_job_id: null,
    raw_len: typeof raw === "string" ? raw.length : JSON.stringify(raw).length,
  };
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const reason = /end of (JSON )?input|Unterminated/i.test(String(e))
        ? "truncated_json"
        : "unparseable_json";
      return {
        ...common,
        validity: "invalid",
        invalid_reason: reason,
        parsed: null,
      };
    }
  }
  if (!documentValid(parsed)) {
    return {
      ...common,
      validity: "invalid",
      invalid_reason: "schema_mismatch",
      parsed: null,
    };
  }
  return { ...common, validity: "valid", invalid_reason: null, parsed };
}

function lift(state: string): any[] {
  const prioritize = body(state, "topicPrioritize");
  const base = {
    contract_version: "delphi-job-result/1",
    conversation_id: prioritize.conversation_id,
    report_id: body(state, "delphi").report_id,
    pinned: false,
    label: null,
  };
  const jobs = body(state, "delphi-visualizations").jobs || [];
  const runs = Object.values<any>(body(state, "delphi").runs);

  if (runs.length === 0) {
    const live = jobs.find((j: any) =>
      ["PENDING", "PROCESSING", "FAILED"].includes(j.status)
    );
    const none = {
      outputs: {},
      omitted: [...DELPHI_FAMILIES],
      failure: null,
      attempt: null,
    };
    if (!live) {
      return [
        {
          ...base,
          ...none,
          job_id: null,
          run_id: null,
          status: "empty",
          as_of: null,
          inputs: null,
        },
      ];
    }
    const inFlight = {
      ...base,
      ...none,
      job_id: live.jobId,
      run_id: null,
      inputs: null,
    };
    if (live.status === "PENDING")
      return [{ ...inFlight, status: "pending", as_of: iso(live.startedAt) }];
    if (live.status === "PROCESSING") {
      return [
        {
          ...inFlight,
          status: "running",
          as_of: iso(live.startedAt),
          attempt: 1,
        },
      ];
    }
    const [code, stage] = String(live.results.error).split(":");
    return [
      {
        ...inFlight,
        status: "failed",
        as_of: iso(live.startedAt),
        attempt: 1,
        failure: {
          code,
          stage: stage || null,
          attempt: 1,
          at: iso(live.completedAt),
        },
      },
    ];
  }

  const stats = body(state, "topicStats").stats;
  const proximity = body(state, "topicMod-proximity").proximity_data;
  const reports = body(state, "delphi-reports").reports;
  const statements = body(state, "collectiveStatement").statements || [];
  const visualizations = jobs.flatMap((j: any) =>
    (j.visualizations || []).map((v: any) => ({
      type: v.type,
      layer_id: v.layerId,
      url: v.url,
      key: v.key,
    }))
  );

  return runs.map((run) => {
    const topics_by_layer: Record<string, any[]> = {};
    let jobId: string = run.job_uuid;
    for (const [layer, clusters] of Object.entries<any>(run.topics_by_layer)) {
      topics_by_layer[layer] = Object.entries<any>(clusters).map(
        ([cluster, t]) => {
          jobId = jobId || jobOf(t.topic_key);
          const s = stats[t.topic_key] || {
            comment_count: 0,
            comment_tids: [],
          };
          return {
            topic_key: t.topic_key,
            layer_id: Number(layer),
            cluster_id: Number(cluster),
            topic_name: t.topic_name,
            model_name: t.model_name,
            comment_count: s.comment_count,
            member_tids: s.comment_tids,
          };
        }
      );
    }
    const outputs = {
      topics_by_layer,
      assignments: Object.fromEntries(
        proximity.map((p: any) => [String(p.comment_id), p.clusters])
      ),
      umap: {
        nodes: proximity.map((p: any) => ({
          tid: p.comment_id,
          x: p.umap_x,
          y: p.umap_y,
          layer_cluster: p.clusters,
          weight: p.weight,
        })),
      },
      visualizations,
      narratives: Object.fromEntries(
        Object.entries<any>(reports).map(([k, v]) => [k, narrative(v)])
      ),
      collective_statements: statements.map((s: any) => ({
        statement_id: s.zid_topic_jobid,
        topic_key: s.topic_key,
        topic_name: s.topic_name,
        created_at: iso(s.created_at),
        model: s.model,
        inputs: {
          topic_job_id: jobOf(s.topic_key),
          assignments_job_id: null,
          math_tick: null,
        },
        statement:
          typeof s.statement_data === "string"
            ? JSON.parse(s.statement_data)
            : s.statement_data,
      })),
    };
    return {
      ...base,
      job_id: jobId,
      run_id: null,
      status: "ready",
      as_of: iso(run.created_date),
      inputs: {
        math_tick: null,
        math_env: null,
        vote_count: null,
        comment_count: proximity.length,
        model: {
          topic_names: run.model_name,
          narrative: null,
          statement: null,
          embedding: null,
        },
        prompt_version: { topic_names: null, narrative: null, statement: null },
      },
      attempt: null,
      failure: null,
      outputs,
      omitted: DELPHI_FAMILIES.filter((f) => !(f in outputs)),
    };
  });
}

const STATES: Array<[string, string]> = [
  ["not_run", "empty"],
  ["pending", "pending"],
  ["running", "running"],
  ["failed", "failed"],
  ["completed", "ready"],
  ["two_models", "ready"],
  ["rerun_after_votes", "ready"],
  ["truncated_narrative", "ready"],
  ["zero_vote", "ready"],
];

(present ? describe : describe.skip)(
  "legacy Delphi recordings lifted into delphi-job-result/1",
  () => {
    test.each(STATES)(
      "%s lifts to %s envelopes that validate",
      (state, status) => {
        const envelopes = lift(state);
        expect(envelopes.length).toBeGreaterThan(0);
        for (const envelope of envelopes) {
          expect(envelope.status).toBe(status);
          expect(ajv(envelope).errors).toEqual([]);
          expect(clientValidate(schema, envelope, false).errors).toEqual([]);
          expect(familiesPartitioned(envelope)).toBe(true);
        }
      }
    );

    test("two models on one day lift to two envelopes told apart by inputs.model", () => {
      const models = lift("two_models").map((e) => e.inputs.model.topic_names);
      expect(new Set(models).size).toBe(2);
    });

    test("the truncated narratives are listed as invalid with a closed reason, never dropped", () => {
      const [envelope] = lift("truncated_narrative");
      const reasons = Object.values<any>(envelope.outputs.narratives).map(
        (n) => n.invalid_reason
      );
      expect(reasons).toContain("truncated_json");
      expect(reasons).toContain("unparseable_json");
      expect(Object.keys(envelope.outputs.narratives)).toHaveLength(
        Object.keys(body("truncated_narrative", "delphi-reports").reports)
          .length
      );
    });

    test.each(["completed", "two_models", "rerun_after_votes", "zero_vote"])(
      "every recorded %s narrative section lifts as valid",
      (state) => {
        for (const envelope of lift(state)) {
          const sections = Object.entries<any>(envelope.outputs.narratives);
          expect(sections.length).toBeGreaterThan(0);
          expect(
            sections.filter(([, n]) => n.validity !== "valid").map(([k]) => k)
          ).toEqual([]);
        }
      }
    );

    test("the parseable truncated_narrative sections lift as valid; only the broken ones are invalid", () => {
      const [envelope] = lift("truncated_narrative");
      const reasons = Object.values<any>(envelope.outputs.narratives).map(
        (n) => n.invalid_reason
      );
      expect(reasons).not.toContain("schema_mismatch");
      expect(reasons.filter((r) => r === null).length).toBeGreaterThan(0);
    });

    test("the recorded completed bodies populate every legacy-served family", () => {
      const [envelope] = lift("completed");
      for (const family of [
        "topics_by_layer",
        "umap",
        "visualizations",
        "narratives",
        "collective_statements",
      ]) {
        const value = envelope.outputs[family];
        expect(
          Array.isArray(value) ? value.length : Object.keys(value).length
        ).toBeGreaterThan(0);
      }
    });
  }
);
