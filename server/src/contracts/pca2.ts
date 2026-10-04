// The `pca2/1` contract: what `GET /api/v3/math/pca2` serves today.
//
// This is the single source of truth for the pca2 schema and the client types
// generated from it (server/src/contracts/generate.ts). It documents the
// current wire shape; it adds no field and changes no byte. The field list
// follows `PcaCacheItem.asPOJO` (server/src/utils/pca.ts), served through
// `presentPca` (server/src/utils/pcaPresentation.ts).
//
// Every object allows additional keys (`[key: string]: any` in pca.ts): the
// Python engine publishes extra keys, and this version describes, it does not
// restrict. The zero-vote structure (`createEmptyPcaStructure`) is a valid
// document with every field present (empty-conversation ruling, 2026-09-21).
// A change to the served shape bumps `$id` to `pca2/2` in the PR that makes it.

import { Static, Type } from "@sinclair/typebox";

export const PCA2_CONTRACT_VERSION = "pca2/1";

const Numbers = Type.Array(Type.Number());

export const Pca2VoteCounts = Type.Object(
  {
    A: Type.Number({ description: "Agree votes." }),
    D: Type.Number({ description: "Disagree votes." }),
    S: Type.Number({
      description:
        "Seen: every vote cast on the comment by the group, agree, disagree and pass.",
    }),
  },
  { title: "Pca2VoteCounts" }
);

export const Pca2GroupVotes = Type.Record(
  Type.String(),
  Type.Object(
    {
      votes: Type.Record(Type.String(), Pca2VoteCounts, {
        description: "Keyed by tid.",
      }),
      "n-members": Type.Optional(Type.Number()),
    },
    { title: "Pca2GroupVoteEntry" }
  ),
  { title: "Pca2GroupVotes", description: "Keyed by group id." }
);

export const Pca2RepnessEntry = Type.Object(
  {
    tid: Type.Number(),
    "repful-for": Type.Optional(Type.String()),
    "p-success": Type.Optional(Type.Number()),
  },
  { title: "Pca2RepnessEntry" }
);

export const Pca2Repness = Type.Record(
  Type.String(),
  Type.Array(Pca2RepnessEntry),
  {
    title: "Pca2Repness",
    description: "Representative comments, keyed by group id.",
  }
);

export const Pca2ConsensusEntry = Type.Object(
  { tid: Type.Number() },
  { title: "Pca2ConsensusEntry" }
);

export const Pca2GroupCluster = Type.Object(
  {
    id: Type.Number(),
    center: Numbers,
    members: Type.Array(Type.Number(), {
      description: "Base-cluster ids, not participant ids.",
    }),
  },
  { title: "Pca2GroupCluster" }
);

export const Pca2BaseClusters = Type.Object(
  {
    x: Numbers,
    y: Numbers,
    id: Numbers,
    count: Numbers,
    members: Type.Array(Numbers, {
      description: "One array of participant ids per base cluster.",
    }),
  },
  { title: "Pca2BaseClusters" }
);

export const Pca2Projection = Type.Object(
  {
    comps: Type.Array(Numbers, { description: "[dimension][participant]." }),
    center: Numbers,
    "comment-extremity": Numbers,
    "comment-projection": Type.Unknown(),
  },
  { title: "Pca2Pca" }
);

export const Pca2 = Type.Object(
  {
    "group-clusters": Type.Array(Pca2GroupCluster),
    "base-clusters": Pca2BaseClusters,
    "group-votes": Type.Optional(Pca2GroupVotes),
    "group-aware-consensus": Type.Optional(
      Type.Record(Type.String(), Type.Number(), {
        description: "Keyed by tid.",
      })
    ),
    "user-vote-counts": Type.Record(Type.String(), Type.Number(), {
      description: "Keyed by pid.",
    }),
    "in-conv": Numbers,
    "n-cmts": Type.Number(),
    n: Type.Number(),
    pca: Pca2Projection,
    tids: Type.Optional(Numbers),
    "mod-in": Type.Optional(Numbers),
    "mod-out": Type.Optional(Numbers),
    "meta-tids": Type.Optional(Numbers),
    repness: Pca2Repness,
    consensus: Type.Object(
      {
        agree: Type.Array(Pca2ConsensusEntry),
        disagree: Type.Array(Pca2ConsensusEntry),
      },
      { title: "Pca2Consensus" }
    ),
    "votes-base": Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    "comment-priorities": Type.Optional(
      Type.Record(Type.String(), Type.Number(), {
        description: "Keyed by tid.",
      })
    ),
    lastModTimestamp: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    lastVoteTimestamp: Type.Optional(Type.Number()),
    math_tick: Type.Number({
      description:
        "The math generation, numeric in JSON. The math_env label is carried only in the ETag.",
    }),
  },
  {
    $id: PCA2_CONTRACT_VERSION,
    title: "Pca2",
    description:
      "GET /api/v3/math/pca2 response body (full document). A response filtered with ?keys= carries a subset of these properties with the same types (Pca2Subset).",
  }
);

export type Pca2 = Static<typeof Pca2>;
