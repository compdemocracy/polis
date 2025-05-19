# PCA JSON Data Object Structure

This document outlines the structure and meaning of the fields within the JSON object returned by the PCA (Principal Component Analysis) data endpoint, often referred to as `math_main` or `pca.json`. This data is crucial for visualizing conversation dynamics, participant groupings, and comment relationships within the Polis system.

The primary TypeScript type definition for this object can be found in `PcaCacheItem` in `server/src/utils/pca.ts`. The backend Clojure code in `math/src/polismath/math/conversation.clj` (specifically `small-conv-update-graph` and `large-conv-update-graph`) defines how this data is generated.

## Top-Level Fields

The root of the JSON object contains several key fields:

| Field Name              | Type                                      | Description                                                                                                                                                              | Example |
|-------------------------|-------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------|
| `n`                     | `number`                                  | Total number of participants who have cast at least one vote in the conversation.                                                                                        | `169`                             |
| `pca`                   | `object`                                  | Contains the core PCA results, including principal components, center, and comment projections. See [PCA Object](#pca-object) section for details.                       | (object)                          |
| `zid`                   | `number`                                  | The conversation ID. This field is present in the raw data from `math_main` but is typically removed before caching (see `updatePcaCache` in `pca.ts`).                  | `37`                              |
| `tids`                  | `number[]`                                | An array of comment (topic) IDs that were included in the PCA calculation.                                                                                               | `[0, 1, 2, ..., 9]`               |
| `mod-in`                | `number[]`                                | An array of comment IDs that have been moderated "in" (approved).                                                                                                        | `[0, 7, 1, ..., 8]`               |
| `n-cmts`                | `number`                                  | The total number of comments included in the PCA.                                                                                                                        | `10`                              |
| `in-conv`               | `number[]`                                | An array of participant IDs (pids) considered "in the conversation" for PCA calculation, typically based on a minimum number of votes cast.                              | `[0, 121, 65, ..., 84]`           |
| `mod-out`               | `number[]`                                | An array of comment IDs that have been moderated "out" (rejected or removed).                                                                                            | `[]`                              |
| `repness`               | `Record<string, RepnessItem[]>`           | An object mapping group IDs (as strings) to arrays of "representative" comments for that group. See [Repness Object](#repness-object-repnessgroupid) for `RepnessItem` structure.       | (object)                          |
| `consensus`             | `object`                                  | Contains arrays of comment IDs that represent points of consensus. See [Consensus Object](#consensus-object) for details.                                                | (object)                          |
| `meta-tids`             | `number[]`                                | Array of comment IDs marked as "meta" comments.                                                                                                                          | `[]`                              |
| `votes-base`            | `Record<string, VotesBaseItem>`           | An object mapping comment IDs (as strings) to vote distributions across base clusters. See [Votes Base Object](#votes-base-object-votes-basecommentid) for `VotesBaseItem` structure.        | (object)                          |
| `group-votes`           | `Record<string, GroupVotesItem>`          | An object mapping group IDs (as strings) to aggregated vote data for that group. See [Group Votes Object](#group-votes-object-group-votesgroupid) for `GroupVotesItem` structure.           | (object)                          |
| `base-clusters`         | `BaseClustersObject`                      | An object describing the base clusters derived from participant projections. See [Base Clusters Object](#base-clusters-object) for details.                              | (object)                          |
| `group-clusters`        | `GroupClusterItem[]`                      | An array of objects, each describing a group cluster. These groups are formed by clustering the `base-clusters`. See [Group Cluster Item](#group-cluster-item-within-group-clusters-array) for details. | (array of objects)             |
| `user-vote-counts`      | `Record<string, number>`                  | An object mapping participant IDs (pids, as strings) to the number of votes they have cast.                                                                              | (object)                          |
| `lastModTimestamp`      | `number` \| `null`                        | Timestamp of the last moderation action.                                                                                                                                 | `null`                            |
| `lastVoteTimestamp`     | `number`                                  | Timestamp of the most recent vote included in this calculation.                                                                                                          | `1740047365775`                   |
| `comment-priorities`    | `Record<string, number>`                  | An object mapping comment IDs (as strings) to their calculated priority scores, used for determining which comments to show next.                                        | (object)                          |
| `group-aware-consensus` | `Record<string, number>`                  | An object mapping comment IDs (as strings) to a "group-aware consensus" score.                                                                                           | (object)                          |
| `math_tick`             | `number`                                  | A version integer indicating when this math data was generated. Used for caching and determining if data is stale.                                                       | 1                                 |
| `subgroup-clusters`     | `Record<string, GroupClusterItem[]>`      | (Potentially ephemeral, processed by `processMathObject`) Describes clusters within each main group.                                                                     | (object)                          |
| `subgroup-votes`        | `Record<string, GroupVotesItem>`          | (Potentially ephemeral, processed by `processMathObject`) Vote data for subgroups.                                                                                       | (object)                          |
| `subgroup-repness`      | `Record<string, RepnessItem[]>`           | (Potentially ephemeral, processed by `processMathObject`) Repness data for subgroups.                                                                                    | (object)                          |

*Note: Fields like `subgroup-clusters`, `subgroup-votes`, and `subgroup-repness` are handled by `processMathObject` in `pca.ts`. Their structure mirrors their top-level counterparts but nested under parent group IDs. They are deleted after processing in `processMathObject`.*

## PCA Object

The `pca` field contains the direct results of the Principal Component Analysis.

| Field Name           | Type         | Description                                                                                                 | Example                           |
|----------------------|--------------|-------------------------------------------------------------------------------------------------------------|-----------------------------------|
| `comps`              | `number[][]` | Principal components. An array of arrays, where each inner array represents a component vector. `comps[0]` is PC1, `comps[1]` is PC2, etc. Each value in an inner array corresponds to a participant's loading on that component for a specific comment (derived from `tids` order). `[dimensions][participants]` in `PcaCacheItem`. | (array of arrays)                 |
| `center`             | `number[]`   | The mean vector of the original data, used for centering before PCA. Each value corresponds to a comment. | `[-0.082..., 0.063..., ...]`      |
| `comment-extremity`  | `number[]`   | A measure of how "extreme" or differentiating each comment is. Higher values mean the comment is more differentiating. Each value corresponds to a comment in `tids` order. | `[1.712..., 1.304..., ...]`      |
| `comment-projection` | `number[][]` | Projections of each comment onto the principal components. `comment-projection[0]` is the projection on PC1, `comment-projection[1]` on PC2. Each inner array has values corresponding to each comment. | (array of arrays)                 |

## Repness Object (`repness[groupId]`)

Each item in the `repness[groupId]` array describes a comment that is representative of that group.

| Field Name       | Type     | Description                                                                                                |
|------------------|----------|------------------------------------------------------------------------------------------------------------|
| `tid`            | `number` | The ID of the representative comment.                                                                      |
| `p-test`         | `number` | Statistical test result related to the comment's representativeness.                                       |
| `repness`        | `number` | A score indicating how representative the comment is for the group.                                        |
| `n-trials`       | `number` | Number of trials/participants involved in this repness calculation for the comment within the group.       |
| `n-success`      | `number` | Number of "successes" (e.g., group members agreeing with a comment the group generally agrees with).       |
| `p-success`      | `number` | Proportion of successes (`n-success / n-trials`).                                                          |
| `repful-for`     | `string` | Indicates if the comment is representative for "agree" or "disagree" sentiments within the group.          |
| `repness-test`   | `number` | Another statistical test value for repness.                                                                |
| `n-agree`        | `number` | (Optional) Number of agreements for this comment within the group.                                         |
| `best-agree`     | `boolean`| (Optional) True if this is the "best agree" comment for the group based on some criteria.                  |

## Consensus Object

Describes comments that have broad agreement or disagreement across the conversation.

| Field Name | Type    | Description                                                                 |
|------------|---------|-----------------------------------------------------------------------------|
| `agree`    | `ConsensusItem[]` | An array of items representing comments with general agreement. See [Consensus Item Structure](#consensus-item-structure) below. |
| `disagree` | `ConsensusItem[]` | An array of items representing comments with general disagreement. See [Consensus Item Structure](#consensus-item-structure) below. |

### Consensus Item Structure

Each object within the `agree` and `disagree` arrays has the following structure, derived from the `select-consensus-comments` and `format-stat` helper functions in `math/src/polismath/math/repness.clj`:

| Field Name    | Type     | Description                                                                                                                                                                |
|---------------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `tid`         | `number` | The ID of the comment.                                                                                                                                                     |
| `n-success`   | `number` | For `agree` items: the count of agree votes (`:na`). For `disagree` items: the count of disagree votes (`:nd`) for that comment across all participants.                  |
| `n-trials`    | `number` | The total number of participants who saw and explicitly voted agree/disagree on the comment (derived from `:ns` in `comment-stats`, which counts non-null votes).             |
| `p-success`   | `number` | The probability of "success" (agreeing or disagreeing). Calculated with a prior: `(+ 1 n-success) / (+ 2 n-trials)`. Corresponds to `:pa` or `:pd` from `comment-stats`.      |
| `p-test`      | `number` | A statistical test value (likely a z-score from `stats/prop-test`) for `p-success`. Corresponds to `:pat` or `:pdt` from `comment-stats`.                                      |

## Votes Base Object (`votes-base[commentId]`)

For each comment ID, this object stores how participants in different base clusters voted.

| Field Name | Type       | Description                                                                                                                                  |
|------------|------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `A`        | `number[]` | Array where each index corresponds to a base cluster. The value is the count of "Agree" votes from participants in that base cluster for this comment. |
| `D`        | `number[]` | Array for "Disagree" vote counts per base cluster.                                                                                           |
| `S`        | `number[]` | Array for the sum of all votes (Agree, Disagree, Pass) per base cluster for this comment.                                                    |

## Group Votes Object (`group-votes[groupId]`)

For each group ID, this object stores aggregated vote counts on comments.

| Field Name    | Type                        | Description                                                                                               |
|---------------|-----------------------------|-----------------------------------------------------------------------------------------------------------|
| `votes`       | `Record<string, VoteCounts>` | An object mapping comment IDs (as strings) to their vote counts within this specific group.              |
| `n-members`   | `number`                    | The total number of participants belonging to this group.                                                 |

### VoteCounts (within `group-votes[groupId].votes[commentId]`)

| Field Name | Type     | Description                                           |
|------------|----------|-------------------------------------------------------|
| `A`        | `number` | Number of "Agree" votes for the comment in this group.    |
| `D`        | `number` | Number of "Disagree" votes for the comment in this group. |
| `S`        | `number` | Sum of all votes (Agree, Disagree, Pass) for the comment in this group. |

## Base Clusters Object

This object describes the initial, finer-grained clusters of participants. These are then clustered again to form the `group-clusters`.

| Field Name | Type         | Description                                                                                                       |
|------------|--------------|-------------------------------------------------------------------------------------------------------------------|
| `x`        | `number[]`   | Array of x-coordinates for each base cluster in the 2D PCA projection. Index corresponds to `id` and `members`.   |
| `y`        | `number[]`   | Array of y-coordinates for each base cluster.                                                                     |
| `id`       | `number[]`   | Array of unique IDs for each base cluster.                                                                        |
| `count`    | `number[]`   | Array indicating the number of participants in each base cluster.                                                 |
| `members`  | `number[][]` | Array of arrays. Each inner array contains the participant IDs (pids) belonging to the corresponding base cluster.  |

## Group Cluster Item (within `group-clusters` array)

Each item in this array describes a higher-level group.

| Field Name | Type       | Description                                                                                                   |
|------------|------------|---------------------------------------------------------------------------------------------------------------|
| `id`       | `number`   | The unique ID of this group cluster.                                                                          |
| `center`   | `number[]` | The [x, y] coordinates of the centroid of this group cluster in the 2D PCA projection.                        |
| `members`  | `number[]` | An array of base cluster IDs that belong to this group cluster. These are IDs from `base-clusters.id`.        |
| `n-members`| `number`   | (Added during processing in `getClusters` in `polis.js`) The total number of participants in this group cluster. This is derived from `group-votes[id]["n-members"]`. |

## Processing and Transformations

It's important to note that the raw data from `math_main` undergoes some processing in `server/src/utils/pca.ts` within the `processMathObject` function before being cached and served to clients. This function:

- Normalizes `group-clusters`, `repness`, `group-votes`, `subgroup-repness`, `subgroup-votes`, and `subgroup-clusters` to be arrays of objects with `id` and `val` properties if they are not already arrays.
- Specifically maps `group-clusters` to have an `id` and `val` structure.
- Converts object-based subgroup properties (like `repness`, `group-votes` if they were objects) into arrays of `{id: number, val: object}`.
- Then, it "un-normalizes" `repness` and `group-votes` back into objects keyed by `id`, and `group-clusters` back into an array of its original `val` objects (where `val` itself contains an `id`).
- Deletes `subgroup-repness`, `subgroup-votes`, and `subgroup-clusters` after their information has potentially been merged or processed.

The client-side code in `client-participation/js/stores/polis.js` further processes this data, for example, by:

- Calculating `myBid` (the bucket ID for the current user).
- Potentially creating "bigBuckets" which are summary buckets for groups.
- Adding participants of interest (PoIs) to the visualization data.
- Projecting the user's own votes (`projectSelf`).

Understanding these transformations is key to interpreting the data correctly both in its stored/cached form and how it's used by the frontend.
