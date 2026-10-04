// The `delphi-job-result/1` contract: one Delphi job's outputs as one
// versioned envelope (P-077 P4 §1).
//
// This is the single source of truth for the schema and the client types
// generated from it (server/src/contracts/generate.ts). No route serves it
// yet; the job-scoped routes and the legacy adapters that will are later
// steps. Five states share one envelope, discriminated by `status`:
//
// - ready:   a completed root; `outputs` carries the requested families.
// - pending: queued, not started; no outputs.
// - running: started; `attempt` is the current attempt (>= 1); no outputs.
// - failed:  terminal; `failure` has a closed code and never log text.
// - empty:   no root exists for the scope; every id is null; no outputs.
//
// Families not served in an envelope are listed in `omitted`, so a client
// never reads "not requested" or "not produced" as "empty". Outside `ready`
// every family is omitted.

import { Static, TSchema, Type } from "@sinclair/typebox";
import { Pca2GroupVotes, Pca2Repness } from "./pca2";

export const DELPHI_JOB_RESULT_CONTRACT_VERSION = "delphi-job-result/1";

export const DELPHI_FAMILIES = [
  "topics_by_layer",
  "assignments",
  "keywords",
  "umap",
  "visualizations",
  "narratives",
  "collective_statements",
  "topic_stats",
  "consensus_inputs",
] as const;

const ISO_8601 =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";

const strict = { additionalProperties: false };

const Timestamp = (description?: string) =>
  Type.String({ pattern: ISO_8601, ...(description ? { description } : {}) });
const Id = (description?: string) =>
  Type.String({ minLength: 1, ...(description ? { description } : {}) });
const Nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const Tid = Type.Integer({ minimum: 0 });
const Count = Type.Integer({ minimum: 0 });

export const DelphiFamily = Type.Union(
  DELPHI_FAMILIES.map((family) => Type.Literal(family)),
  { title: "DelphiFamily" }
);

// --- families -------------------------------------------------------------

export const Topic = Type.Object(
  {
    topic_key: Id("`<job_id>#<layer>#<cluster>`."),
    layer_id: Type.Integer({ minimum: 0 }),
    cluster_id: Type.Integer(),
    topic_name: Type.String(),
    model_name: Type.String(),
    comment_count: Count,
    member_tids: Type.Array(Tid),
  },
  { ...strict, title: "Topic" }
);

export const TopicsByLayer = Type.Record(Type.String(), Type.Array(Topic), {
  title: "TopicsByLayer",
  description: "Keyed by layer id.",
});

export const Assignments = Type.Record(
  Type.String(),
  Type.Record(Type.String(), Type.Integer()),
  {
    title: "Assignments",
    description:
      "tid -> layer id -> cluster id (-1 is unassigned). Topic membership is carried by Topic.member_tids and topic_stats[*].comment_tids.",
  }
);

export const Keywords = Type.Record(Type.String(), Type.Array(Type.String()), {
  title: "Keywords",
  description: "Keyed by topic_key.",
});

export const UmapNode = Type.Object(
  {
    tid: Tid,
    x: Type.Number(),
    y: Type.Number(),
    layer_cluster: Type.Record(Type.String(), Type.Integer(), {
      description: "Layer id -> cluster id (-1 is unassigned).",
    }),
    weight: Type.Optional(Type.Number()),
  },
  {
    ...strict,
    title: "UmapNode",
    description:
      "A comment position. Participant-safe: never carries comment text.",
  }
);

export const UmapEdge = Type.Object(
  {
    source: Tid,
    target: Tid,
    weight: Type.Number(),
    distance: Type.Optional(Type.Number()),
    is_nearest_neighbor: Type.Optional(Type.Boolean()),
  },
  { ...strict, title: "UmapEdge" }
);

export const Umap = Type.Object(
  {
    nodes: Type.Array(UmapNode),
    edges: Type.Optional(Type.Array(UmapEdge)),
  },
  { ...strict, title: "Umap" }
);

export const Visualization = Type.Object(
  {
    type: Type.String({
      description: "For example `interactive` or `static_png`.",
    }),
    layer_id: Type.Integer({ minimum: 0 }),
    url: Type.String(),
    key: Type.String(),
  },
  { ...strict, title: "Visualization" }
);

// Narrative and statement documents are what the LLM produced, parsed and
// validated server-side; nested objects allow additional keys.
export const NarrativeClause = Type.Object(
  { text: Type.String(), citations: Type.Array(Tid) },
  { title: "NarrativeClause" }
);

export const NarrativeSentence = Type.Object(
  { clauses: Type.Array(NarrativeClause) },
  { title: "NarrativeSentence" }
);

export const NarrativeParagraph = Type.Object(
  {
    id: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    sentences: Type.Array(NarrativeSentence),
  },
  { title: "NarrativeParagraph" }
);

export const NarrativeDocument = Type.Object(
  {
    id: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    paragraphs: Type.Array(NarrativeParagraph),
  },
  { title: "NarrativeDocument" }
);

const narrativeSectionCommon = {
  model: Type.String(),
  created_at: Timestamp(),
  source_topic_job_id: Nullable(
    Id("The topic root this narrative was built over.")
  ),
  raw_len: Type.Integer({
    minimum: 0,
    description:
      "Length of the stored model output. The raw text is never served.",
  }),
};

export const NarrativeSectionValid = Type.Object(
  {
    ...narrativeSectionCommon,
    validity: Type.Literal("valid"),
    invalid_reason: Type.Null(),
    parsed: NarrativeDocument,
  },
  { ...strict, title: "NarrativeSectionValid" }
);

export const NarrativeInvalidReason = Type.Union(
  [
    Type.Literal("truncated_json"),
    Type.Literal("unparseable_json"),
    Type.Literal("schema_mismatch"),
  ],
  { title: "NarrativeInvalidReason" }
);

export const NarrativeSectionInvalid = Type.Object(
  {
    ...narrativeSectionCommon,
    validity: Type.Literal("invalid"),
    invalid_reason: NarrativeInvalidReason,
    parsed: Type.Null(),
  },
  {
    ...strict,
    title: "NarrativeSectionInvalid",
    description:
      "A section whose stored output failed parsing or validation. Listed, never dropped and never repaired.",
  }
);

export const NarrativeSection = Type.Union(
  [NarrativeSectionValid, NarrativeSectionInvalid],
  { title: "NarrativeSection" }
);

export const Narratives = Type.Record(Type.String(), NarrativeSection, {
  title: "Narratives",
  description: "Keyed by section.",
});

export const CollectiveStatement = Type.Object(
  {
    statement_id: Id(),
    topic_key: Id(),
    topic_name: Type.String(),
    created_at: Timestamp(),
    model: Type.String(),
    inputs: Type.Object(
      {
        topic_job_id: Id(),
        assignments_job_id: Nullable(Id()),
        math_tick: Nullable(Type.Integer({ minimum: 0 })),
      },
      {
        ...strict,
        title: "CollectiveStatementInputs",
        description:
          "What the statement was computed against; null where a legacy statement did not record it.",
      }
    ),
    statement: NarrativeDocument,
  },
  {
    ...strict,
    title: "CollectiveStatement",
    description:
      "A stored statement. Reads list stored statements and never generate one.",
  }
);

export const TopicStatsEntry = Type.Object(
  {
    comment_tids: Type.Array(Tid),
    agree: Count,
    disagree: Count,
    pass: Count,
    seen: Type.Integer({
      minimum: 0,
      description: "agree + disagree + pass, summed over the topic's comments.",
    }),
    group_aware_consensus: Nullable(Type.Number()),
    normalized_consensus: Nullable(Type.Number()),
  },
  {
    ...strict,
    title: "TopicStatsEntry",
    description:
      "Computed server-side from the captured math snapshot; vote counts are over every voter, not only clustered participants.",
  }
);

export const TopicStats = Type.Record(Type.String(), TopicStatsEntry, {
  title: "TopicStats",
  description: "Keyed by topic_key.",
});

export const CommentVotes = Type.Object(
  { agree_count: Count, disagree_count: Count, pass_count: Count },
  {
    ...strict,
    title: "CommentVotes",
    description:
      "One comment's vote counts over every voter (the /comments agree_count, disagree_count, pass_count).",
  }
);

export const ConsensusInputs = Type.Object(
  {
    group_votes: Pca2GroupVotes,
    repness: Pca2Repness,
    group_aware_consensus: Type.Record(Type.String(), Type.Number(), {
      description:
        "Keyed by tid: pca2 group-aware-consensus at the captured tick.",
    }),
    group_consensus_normalized: Type.Record(Type.String(), Type.Number(), {
      description:
        "Keyed by tid: group-aware consensus normalized server-side (the client's group-consensus-normalized).",
    }),
    comment_votes: Type.Record(Type.String(), CommentVotes, {
      description: "Keyed by tid.",
    }),
  },
  {
    ...strict,
    title: "ConsensusInputs",
    description:
      "The per-comment math the topic pages read, from the captured snapshot (inputs.math_tick), so a page never mixes live pca2 or live comment counts with an older topic set. On a zero-vote root every map is present and empty.",
  }
);

export const DelphiJobOutputs = Type.Object(
  {
    topics_by_layer: Type.Optional(TopicsByLayer),
    assignments: Type.Optional(Assignments),
    keywords: Type.Optional(Keywords),
    umap: Type.Optional(Umap),
    visualizations: Type.Optional(Type.Array(Visualization)),
    narratives: Type.Optional(Narratives),
    collective_statements: Type.Optional(Type.Array(CollectiveStatement)),
    topic_stats: Type.Optional(TopicStats),
    consensus_inputs: Type.Optional(ConsensusInputs),
  },
  {
    ...strict,
    title: "DelphiJobOutputs",
    description:
      "Every family present here is absent from `omitted`, and the reverse.",
  }
);

const NoOutputs = Type.Object({}, { ...strict, title: "DelphiJobNoOutputs" });

// --- envelope -------------------------------------------------------------

export const JobInputs = Type.Object(
  {
    math_tick: Nullable(Type.Integer({ minimum: 0 })),
    math_env: Nullable(Type.String()),
    vote_count: Nullable(Count),
    comment_count: Nullable(Count),
    model: Type.Object(
      {
        topic_names: Type.String(),
        narrative: Nullable(Type.String()),
        statement: Nullable(Type.String()),
        embedding: Nullable(Type.String()),
      },
      { ...strict, title: "JobModels" }
    ),
    prompt_version: Type.Object(
      {
        topic_names: Nullable(Type.String()),
        narrative: Nullable(Type.String()),
        statement: Nullable(Type.String()),
      },
      { ...strict, title: "JobPromptVersions" }
    ),
  },
  {
    ...strict,
    title: "JobInputs",
    description:
      "The math snapshot the root captured at start, and the models and prompt versions it ran with. Null leaves mean the root did not record it (legacy imports).",
  }
);

export const FailureCode = Type.Union(
  [
    Type.Literal("stage_failed"),
    Type.Literal("manifest_invalid"),
    Type.Literal("timeout"),
    Type.Literal("lease_expired"),
    Type.Literal("unknown_stage"),
    Type.Literal("provider_failed"),
    Type.Literal("cancelled"),
  ],
  { title: "FailureCode" }
);

export const Failure = Type.Object(
  {
    code: FailureCode,
    stage: Nullable(Type.String({ minLength: 1 })),
    attempt: Type.Integer({ minimum: 1 }),
    at: Timestamp(),
  },
  {
    ...strict,
    title: "Failure",
    description:
      "Never carries log text, an exception message or a stack trace.",
  }
);

const AllFamiliesOmitted = Type.Array(DelphiFamily, {
  minItems: DELPHI_FAMILIES.length,
  maxItems: DELPHI_FAMILIES.length,
  uniqueItems: true,
  description: "Every family: this state carries no outputs.",
});

function envelope(
  status: "ready" | "pending" | "running" | "failed" | "empty",
  title: string,
  description: string,
  fields: {
    job_id: TSchema;
    run_id: TSchema;
    as_of: TSchema;
    inputs: TSchema;
    attempt: TSchema;
    failure: TSchema;
    pinned: TSchema;
    label: TSchema;
    outputs: TSchema;
    omitted: TSchema;
  }
) {
  return Type.Object(
    {
      contract_version: Type.Literal(DELPHI_JOB_RESULT_CONTRACT_VERSION),
      job_id: fields.job_id,
      run_id: fields.run_id,
      conversation_id: Id("The conversation's zinvite, never zid."),
      report_id: Nullable(Id()),
      status: Type.Literal(status),
      as_of: fields.as_of,
      inputs: fields.inputs,
      attempt: fields.attempt,
      failure: fields.failure,
      pinned: fields.pinned,
      label: fields.label,
      outputs: fields.outputs,
      omitted: fields.omitted,
    },
    { ...strict, title, description }
  );
}

const JobId = Id(
  "Public job id: a uuid, or the frozen alias of a legacy import."
);
const RunId = Nullable(Id("Queue execution identity; null for imports."));

export const DelphiJobResultReady = envelope(
  "ready",
  "DelphiJobResultReady",
  "A completed root. as_of is its completed_at.",
  {
    job_id: JobId,
    run_id: RunId,
    as_of: Timestamp(),
    inputs: JobInputs,
    attempt: Type.Null(),
    failure: Type.Null(),
    pinned: Type.Boolean(),
    label: Nullable(Type.String()),
    outputs: DelphiJobOutputs,
    omitted: Type.Array(DelphiFamily, { uniqueItems: true }),
  }
);

export const DelphiJobResultPending = envelope(
  "pending",
  "DelphiJobResultPending",
  "Queued and not started.",
  {
    job_id: JobId,
    run_id: RunId,
    as_of: Nullable(Timestamp()),
    inputs: Nullable(JobInputs),
    attempt: Type.Null(),
    failure: Type.Null(),
    pinned: Type.Boolean(),
    label: Nullable(Type.String()),
    outputs: NoOutputs,
    omitted: AllFamiliesOmitted,
  }
);

export const DelphiJobResultRunning = envelope(
  "running",
  "DelphiJobResultRunning",
  "Started. as_of is its started_at; attempt is the current attempt.",
  {
    job_id: JobId,
    run_id: RunId,
    as_of: Timestamp(),
    inputs: Nullable(JobInputs),
    attempt: Type.Integer({ minimum: 1 }),
    failure: Type.Null(),
    pinned: Type.Boolean(),
    label: Nullable(Type.String()),
    outputs: NoOutputs,
    omitted: AllFamiliesOmitted,
  }
);

export const DelphiJobResultFailed = envelope(
  "failed",
  "DelphiJobResultFailed",
  "Terminal. as_of is its started_at; attempt is the attempt that ended the run. A rerun is a new root.",
  {
    job_id: JobId,
    run_id: RunId,
    as_of: Timestamp(),
    inputs: Nullable(JobInputs),
    attempt: Type.Integer({ minimum: 1 }),
    failure: Failure,
    pinned: Type.Boolean(),
    label: Nullable(Type.String()),
    outputs: NoOutputs,
    omitted: AllFamiliesOmitted,
  }
);

export const DelphiJobResultEmpty = envelope(
  "empty",
  "DelphiJobResultEmpty",
  "No root exists for the scope (never run).",
  {
    job_id: Type.Null(),
    run_id: Type.Null(),
    as_of: Type.Null(),
    inputs: Type.Null(),
    attempt: Type.Null(),
    failure: Type.Null(),
    pinned: Type.Literal(false),
    label: Type.Null(),
    outputs: NoOutputs,
    omitted: AllFamiliesOmitted,
  }
);

export const DelphiJobResult = Type.Union(
  [
    DelphiJobResultReady,
    DelphiJobResultPending,
    DelphiJobResultRunning,
    DelphiJobResultFailed,
    DelphiJobResultEmpty,
  ],
  {
    $id: DELPHI_JOB_RESULT_CONTRACT_VERSION,
    title: "DelphiJobResult",
    description:
      "One Delphi job's outputs as one versioned envelope, discriminated by status.",
  }
);

export type DelphiJobResult = Static<typeof DelphiJobResult>;
export type DelphiFamily = (typeof DELPHI_FAMILIES)[number];
