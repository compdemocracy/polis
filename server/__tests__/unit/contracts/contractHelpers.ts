// Shared helpers for the contract tests: ajv validators compiled from the
// committed schema files, the client-report validator evaluated from the same
// text the client ships, and generated fixtures for every envelope state.

import Ajv from "ajv";
import fs from "fs";
import path from "path";
import { CLIENT_VALIDATOR_CORE } from "../../../src/contracts/clientReportValidator";
import {
  DELPHI_FAMILIES,
  DelphiJobResult,
} from "../../../src/contracts/delphiJobResult";

export const SERVER_ROOT = path.resolve(__dirname, "..", "..", "..");

export function committedSchema(name: "delphiJobResult" | "pca2"): any {
  return JSON.parse(
    fs.readFileSync(
      path.join(SERVER_ROOT, "src", "contracts", `${name}.schema.json`),
      "utf8"
    )
  );
}

export function ajvValidator(schema: any) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  return (value: unknown) => {
    const valid = validate(value) as boolean;
    return {
      valid,
      errors: valid ? [] : ajv.errorsText(validate.errors).split(", "),
    };
  };
}

type ClientValidate = (
  schema: any,
  value: unknown,
  subset: boolean
) => { valid: boolean; errors: string[] };

// eslint-disable-next-line no-new-func
export const clientValidate: ClientValidate = new Function(
  `${CLIENT_VALIDATOR_CORE}\nreturn contractValidate;`
)();

/** pca2 subset schema: the same properties, none required (a ?keys= response). */
export function subsetSchema(schema: any): any {
  return { ...schema, required: [] };
}

// --- generated fixtures ---------------------------------------------------

const JOB = "0000a001-0000-4000-8000-000000000001";
const NARRATIVE_JOB = "0000a001-0000-4000-8000-0000000000b1";
const CONVERSATION = "2gen4p1";
const REPORT = "r4p1gen";

export const generatedInputs = () => ({
  math_tick: 42,
  math_env: "python",
  vote_count: 120,
  comment_count: 8,
  model: {
    topic_names: "generated-model-alpha",
    narrative: "generated-model-alpha",
    statement: null,
    embedding: "generated-embedding",
  },
  prompt_version: {
    topic_names: "topic-names-v1",
    narrative: "narrative-v1",
    statement: null,
  },
});

const doc = (title: string) => ({
  id: "generated_narrative",
  title,
  paragraphs: [
    {
      id: "p1",
      title: `${title}: paragraph`,
      sentences: [
        {
          clauses: [
            { text: "Generated clause one. ", citations: [0, 1] },
            { text: "Generated clause two.", citations: [] },
          ],
        },
      ],
    },
  ],
});

/** One generated value for every family. */
export const generatedOutputs = (): Record<string, unknown> => ({
  topics_by_layer: {
    "0": [
      {
        topic_key: `${JOB}#0#0`,
        layer_id: 0,
        cluster_id: 0,
        topic_name: "Generated topic 0.0",
        model_name: "generated-model-alpha",
        comment_count: 2,
        member_tids: [0, 3],
      },
      {
        topic_key: `${JOB}#0#1`,
        layer_id: 0,
        cluster_id: 1,
        topic_name: "Generated topic 0.1",
        model_name: "generated-model-alpha",
        comment_count: 1,
        member_tids: [1],
      },
    ],
    "1": [
      {
        topic_key: `${JOB}#1#0`,
        layer_id: 1,
        cluster_id: 0,
        topic_name: "Generated topic 1.0",
        model_name: "generated-model-alpha",
        comment_count: 3,
        member_tids: [0, 1, 3],
      },
    ],
  },
  assignments: {
    "0": { "0": 0, "1": 0 },
    "1": { "0": 1, "1": 0 },
    "2": { "0": -1, "1": -1 },
    "3": { "0": 0, "1": 0 },
  },
  keywords: {
    [`${JOB}#0#0`]: ["generated", "keyword"],
    [`${JOB}#0#1`]: [],
  },
  umap: {
    nodes: [
      {
        tid: 0,
        x: 0.125,
        y: -0.5,
        layer_cluster: { "0": 0, "1": 0 },
        weight: 1,
      },
      { tid: 1, x: 1.125, y: -1.5, layer_cluster: { "0": 1, "1": 0 } },
    ],
    edges: [
      {
        source: 0,
        target: 1,
        weight: 0.75,
        distance: 0.25,
        is_nearest_neighbor: true,
      },
    ],
  },
  visualizations: [
    {
      type: "interactive",
      layer_id: 0,
      url: "http://store.generated.invalid/visualizations/layer_0_datamapplot.html",
      key: "visualizations/r4p1gen/layer_0_datamapplot.html",
    },
    {
      type: "static_png",
      layer_id: 0,
      url: "http://store.generated.invalid/visualizations/layer_0_static.png",
      key: "visualizations/r4p1gen/layer_0_static.png",
    },
  ],
  narratives: {
    group_informed_consensus: {
      model: "generated-model-alpha",
      created_at: "2026-10-03T12:00:00.000Z",
      source_topic_job_id: JOB,
      validity: "valid",
      invalid_reason: null,
      parsed: doc("Generated consensus"),
      raw_len: 412,
    },
    [`${JOB}_0_0`]: {
      model: "generated-model-alpha",
      created_at: "2026-10-03T12:00:01.000001+00:00",
      source_topic_job_id: JOB,
      validity: "invalid",
      invalid_reason: "truncated_json",
      parsed: null,
      raw_len: 4096,
    },
  },
  collective_statements: [
    {
      statement_id: `${JOB}#0#1#0000a001-0000-4000-8000-00000000c001`,
      topic_key: `${JOB}#0#1`,
      topic_name: "Generated topic 0.1",
      created_at: "2026-10-03T12:10:00.000Z",
      model: "generated-model-alpha",
      inputs: { topic_job_id: JOB, assignments_job_id: JOB, math_tick: 42 },
      statement: doc("Generated statement"),
    },
  ],
  topic_stats: {
    [`${JOB}#0#0`]: {
      comment_tids: [0, 3],
      agree: 10,
      disagree: 4,
      pass: 6,
      seen: 20,
      group_aware_consensus: 0.42,
      normalized_consensus: 0.6,
    },
    [`${JOB}#0#1`]: {
      comment_tids: [1],
      agree: 0,
      disagree: 0,
      pass: 0,
      seen: 0,
      group_aware_consensus: null,
      normalized_consensus: null,
    },
  },
  consensus_inputs: {
    group_votes: {
      "0": { votes: { "0": { A: 3, D: 1, S: 5 } }, "n-members": 4 },
      "1": { votes: { "0": { A: 0, D: 2, S: 2 } }, "n-members": 2 },
    },
    repness: {
      "0": [{ tid: 0, "repful-for": "agree", "p-success": 0.75 }],
      "1": [{ tid: 0, "repful-for": "disagree", "p-success": 0.9 }],
    },
    group_aware_consensus: { "0": 0.42, "1": 0.05, "3": 0.31 },
    group_consensus_normalized: { "0": 0.6, "1": 0.07, "3": 0.44 },
    comment_votes: {
      "0": { agree_count: 6, disagree_count: 2, pass_count: 4 },
      "1": { agree_count: 0, disagree_count: 0, pass_count: 0 },
      "3": { agree_count: 4, disagree_count: 2, pass_count: 2 },
    },
  },
});

const common = () => ({
  contract_version: "delphi-job-result/1" as const,
  conversation_id: CONVERSATION,
  report_id: REPORT,
});

const noOutputs = () => ({ outputs: {}, omitted: [...DELPHI_FAMILIES] });

/** A generated fixture for each of the five states (ready carries every family). */
export function generatedEnvelopes(): Record<string, DelphiJobResult> {
  return {
    ready: {
      ...common(),
      job_id: JOB,
      run_id: "0000a001-0000-4000-8000-0000000000e1",
      status: "ready",
      as_of: "2026-10-03T12:00:00.000Z",
      inputs: generatedInputs(),
      attempt: null,
      failure: null,
      pinned: true,
      label: "Generated pinned run",
      outputs: generatedOutputs(),
      omitted: [],
    } as DelphiJobResult,
    pending: {
      ...common(),
      job_id: JOB,
      run_id: null,
      status: "pending",
      as_of: null,
      inputs: null,
      attempt: null,
      failure: null,
      pinned: false,
      label: null,
      ...noOutputs(),
    } as DelphiJobResult,
    running: {
      ...common(),
      job_id: JOB,
      run_id: "0000a001-0000-4000-8000-0000000000e2",
      status: "running",
      as_of: "2026-10-03T11:50:00.000Z",
      inputs: generatedInputs(),
      attempt: 2,
      failure: null,
      pinned: false,
      label: null,
      ...noOutputs(),
    } as DelphiJobResult,
    failed: {
      ...common(),
      job_id: JOB,
      run_id: "0000a001-0000-4000-8000-0000000000e3",
      status: "failed",
      as_of: "2026-10-03T11:50:00.000Z",
      inputs: generatedInputs(),
      attempt: 3,
      failure: {
        code: "stage_failed",
        stage: "topic_naming",
        attempt: 3,
        at: "2026-10-03T11:59:00Z",
      },
      pinned: false,
      label: null,
      ...noOutputs(),
    } as DelphiJobResult,
    empty: {
      ...common(),
      report_id: null,
      job_id: null,
      run_id: null,
      status: "empty",
      as_of: null,
      inputs: null,
      attempt: null,
      failure: null,
      pinned: false,
      label: null,
      ...noOutputs(),
    } as DelphiJobResult,
  };
}

/** A ready envelope serving only `family` (the ?families= form). */
export function readyWithOnly(family: string): any {
  const ready: any = generatedEnvelopes().ready;
  return {
    ...ready,
    job_id: NARRATIVE_JOB,
    outputs: { [family]: (generatedOutputs() as any)[family] },
    omitted: DELPHI_FAMILIES.filter((f) => f !== family),
  };
}

/** The contract invariant the schema states in prose: outputs and omitted partition the families. */
export function familiesPartitioned(envelope: any): boolean {
  const present = Object.keys(envelope.outputs);
  const omitted: string[] = envelope.omitted;
  return (
    DELPHI_FAMILIES.every((f) => present.includes(f) !== omitted.includes(f)) &&
    present.every((f) => (DELPHI_FAMILIES as readonly string[]).includes(f))
  );
}

/**
 * Generated fixtures for the nine recorded states of P4 §3 (map 6 §7.4 plus
 * running and failed), each as the envelope the job routes will serve.
 */
export function nineStateEnvelopes(): Record<string, any> {
  const s = generatedEnvelopes();
  const ready: any = s.ready;
  const outputs: any = generatedOutputs();
  const secondModel = {
    ...ready,
    job_id: "0000a001-0000-4000-8000-000000000002",
    pinned: false,
    label: null,
    inputs: {
      ...generatedInputs(),
      model: {
        ...generatedInputs().model,
        topic_names: "generated-model-beta",
        narrative: "generated-model-beta",
      },
    },
  };
  return {
    not_run: s.empty,
    pending: s.pending,
    completed: ready,
    two_models_alpha: ready,
    two_models_beta: secondModel,
    rerun_after_votes: {
      ...ready,
      job_id: "0000a001-0000-4000-8000-000000000003",
      as_of: "2026-10-03T13:00:00.000Z",
      inputs: { ...generatedInputs(), math_tick: 43, vote_count: 150 },
    },
    truncated_narrative: {
      ...ready,
      outputs: {
        ...outputs,
        narratives: {
          [`${JOB}_0_0`]: outputs.narratives[`${JOB}_0_0`],
          [`${JOB}_0_1`]: {
            ...outputs.narratives[`${JOB}_0_0`],
            invalid_reason: "unparseable_json",
          },
          [`${JOB}_0_2`]: {
            ...outputs.narratives[`${JOB}_0_0`],
            invalid_reason: "schema_mismatch",
          },
        },
      },
    },
    zero_vote: {
      ...ready,
      inputs: { ...generatedInputs(), math_tick: 0, vote_count: 0 },
      outputs: {
        ...outputs,
        topic_stats: {
          [`${JOB}#0#0`]: {
            comment_tids: [0, 3],
            agree: 0,
            disagree: 0,
            pass: 0,
            seen: 0,
            group_aware_consensus: null,
            normalized_consensus: null,
          },
        },
        consensus_inputs: {
          group_votes: {},
          repness: {},
          group_aware_consensus: {},
          group_consensus_normalized: {},
          comment_votes: {},
        },
      },
    },
    running: s.running,
    failed: s.failed,
  };
}
