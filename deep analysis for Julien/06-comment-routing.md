# Comment Routing Analysis

## 1. Overview

Comment routing determines which comment a participant sees next when they're ready to vote. The TypeScript server (`server/src/nextComment.ts`) mediates between two routing strategies:

1. **Prioritized routing**: Uses math-computed priority scores for weighted random selection
2. **Topical routing**: Uses Delphi-generated topic clusters filtered by participant preferences

---

## 2. Entry Point

### `getNextComment()` (`nextComment.ts` lines 339–381)

```typescript
export async function getNextComment(zid, pid, withoutTids, lang) {
    const ratio = Config.getValidTopicalRatio();
    // ratio is TOPICAL_COMMENT_RATIO env var, float [0,1] or null

    const shouldUseTopical =
        typeof ratio === 'number' && ratio > 0 &&
        Math.random() < ratio &&      // probabilistic split
        pid !== -1;                    // not anonymous

    let next = null;
    if (shouldUseTopical) {
        next = await getNextTopicalComment(zid, pid, withoutTids);
    } else {
        next = await getNextPrioritizedComment(zid, pid, withoutTids);
    }

    // Fallback: if topical yielded nothing, try prioritized
    if (!next && shouldUseTopical) {
        next = await getNextPrioritizedComment(zid, pid, withoutTids);
    }

    if (!next) return next;
    await ensureTranslations(zid, next, lang);
    return next;
}
```

**Key design**: The split is probabilistic. With `TOPICAL_COMMENT_RATIO=0.5`, each request has a 50% chance of using topical routing and 50% prioritized.

---

## 3. Prioritized Routing (Legacy Path)

### `getNextPrioritizedComment()` (`nextComment.ts` lines 51–103)

```typescript
async function getNextPrioritizedComment(zid, pid, withoutTids) {
    const [comments, mathRaw, remainingRows] = await Promise.all([
        getComments({zid, not_voted_by_pid: pid, ...}),  // unvoted comments
        getPca(zid, 0),                                    // math results from DB
        getNumberOfCommentsRemaining(zid, pid),            // count
    ]);

    const commentPriorities = math.asPOJO?.['comment-priorities'] || {};
    const selectedRow = selectProbabilistically(comments, commentPriorities);
    selectedRow.remaining = remainingCount;
    selectedRow.total = totalCount;
    return selectedRow;
}
```

**Data flow**:
1. Fetch all comments the participant hasn't voted on
2. Fetch `comment-priorities` from the math results stored in `math_main` table
3. Use weighted random selection

### `selectProbabilistically()` (`nextComment.ts` lines 105–140)

```typescript
function selectProbabilistically(comments, priorities) {
    // Build cumulative weight lookup
    const lookup = _.reduce(comments, (o, comment) => {
        const lookup_val = o.lastCount + (priorities[comment.tid] || 1);
        //                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
        //                                default weight = 1 if no priority
        o.lookup.push([lookup_val, comment]);
        o.lastCount = lookup_val;
        return o;
    }, { lastCount: 0, lookup: [] });

    // Weighted random selection
    const randomN = Math.random() * lookup.lastCount;
    const result = _.find(lookup.lookup, (x) => x[0] > randomN);
    return result[1];
}
```

**Mathematical formulation**:

Given comments `c_1, ..., c_n` with priorities `w_1, ..., w_n` (default `w_i = 1`):

```
P(select c_i) = w_i / Σ_j w_j
```

This is **probability-proportional-to-size (PPS) sampling** without replacement of the selection step. Each comment's selection probability is proportional to its priority weight.

**Example** with priorities {A: 49, B: 4, C: 1}:
```
P(A) = 49/54 = 90.7%    ← meta comment (priority^2 = 7^2)
P(B) = 4/54  = 7.4%     ← normal comment
P(C) = 1/54  = 1.9%     ← default (no priority computed)
```

---

## 4. Topical Routing (Delphi Path)

### `getNextTopicalComment()` (`nextComment.ts` lines 285–327)

```typescript
export async function getNextTopicalComment(zid, pid, withoutTids) {
    const tids = await getTidsForParticipantTopicAgenda(zid, pid);
    if (!tids || tids.length === 0) {
        return getNextPrioritizedComment(zid, pid, withoutTids);  // fallback
    }

    const rows = await getComments({
        zid,
        not_voted_by_pid: pid,
        tids,                   // restrict to topic-relevant comments
        withoutTids,
        random: true,           // uniform random within pool
        limit: 1,
    });

    if (!rows[0]) {
        return getNextPrioritizedComment(zid, pid, withoutTids);  // fallback
    }

    return { zid, tid: rows[0].tid, txt: rows[0].txt };
}
```

### `getTidsForParticipantTopicAgenda()` (`nextComment.ts` lines 153–276)

```
1. Query PostgreSQL: topic_agenda_selections WHERE zid AND pid
   → Get archetypal_selections array (participant's chosen topics)

2. Extract unique topic_keys from selections

3. For each topic_key:
   Query DynamoDB: Delphi_CommentClustersLLMTopicNames
   → Get (layer_id, cluster_id) for each topic

4. For each (layer_id, cluster_id):
   Query DynamoDB: Delphi_CommentHierarchicalClusterAssignments
   → Get all comment tids in that cluster

5. De-duplicate and return tids
```

**Key difference from prioritized**: Topical routing uses **uniform random** selection within the filtered pool (no weighting). The filtering is by LLM-generated topic clusters, not by math-computed priorities.

---

## 5. How Comment Priorities Reach the Server

### 5.1 Clojure Pipeline

```
conversation.clj:comment-priorities
    → Serialized into math_main.data JSON blob in PostgreSQL
    → Read by server via getPca(zid, 0)
    → Extracted as math.asPOJO['comment-priorities']
    → Passed to selectProbabilistically()
```

The Clojure pipeline computes fresh priorities on each update and stores them in the `math_main` table.

### 5.2 Delphi (Python) Pipeline

Python does NOT compute comment priorities (see 05-participant-filtering.md Section 4). This means:

- If running Delphi instead of Clojure math, `comment-priorities` will be empty (`{}`)
- `selectProbabilistically()` will default every comment to weight 1
- Result: **uniform random selection** — all comments equally likely

**Impact**: The entire priority-based routing degrades to random selection when using Delphi.

---

## 6. Server API Endpoints

### GET `/api/v3/nextComment`

Handler: `handle_GET_nextComment()` in `routes/comments.ts`

Parameters:
- `zid` — conversation ID
- `not_voted_by_pid` — participant ID (exclude already-voted)
- `without` — array of tids to exclude
- `lang` — language for translation

Response:
```json
{
    "tid": 42,
    "txt": "The comment text...",
    "created": 1703000000000,
    "remaining": 15,
    "total": 50,
    "currentPid": 7
}
```

### POST `/api/v3/votes`

Handler: `handle_POST_votes()` in `routes/votes.ts`

After recording the vote, the handler calls `getNextComment()` and includes the next comment in the response, enabling seamless vote → next comment flow without a separate request.

---

## 7. Comparison: Delphi vs Legacy Comment Routing

| Aspect | Legacy (Clojure + Prioritized) | Delphi (Topical) |
|--------|-------------------------------|------------------|
| Selection pool | All unvoted comments | Only topic-relevant unvoted comments |
| Weighting | Priority scores (importance × novelty) | Uniform random within pool |
| Novelty boost | Yes (`2^(S/-5)` decay) | No |
| Meta comments | 7× priority boost (squared: 49×) | Not distinguished |
| Extremity factor | Yes (PCA comment projection norm) | No |
| Topic filtering | No | Yes (LLM-generated clusters) |
| Participant prefs | No | Yes (topic_agenda_selections) |
| Fallback | Uniform random if no priorities | Prioritized routing |
| Data source | math_main PostgreSQL table | DynamoDB + PostgreSQL |

### 7.1 Strengths of Legacy Approach
- Comments with high information value (high extremity, low vote count) surface faster
- Meta/featured comments get strong priority boost
- Battle-tested across many conversations

### 7.2 Strengths of Delphi Approach
- Respects participant interests (topic selection)
- LLM-generated topics can be more semantically meaningful
- Reduces survey fatigue by focusing on relevant topics

### 7.3 Current Hybrid
The `TOPICAL_COMMENT_RATIO` parameter blends both approaches probabilistically. When set to 0.5, each comment request has a 50% chance of using each strategy.

---

## 8. Client-Side Integration

### `client-participation/js/stores/polis.js` (lines 157–194)

```javascript
getNextComment(o) {
    params = {
        not_voted_by_pid: myPid,
        limit: 1,
        conversation_id: conversation_id,
        lang: Utils.uiLanguage()
    };
    if (o.notTid) {
        params.without = [o.notTid];  // exclude current comment
    }
    return polisGet('api/v3/nextComment', params)
        .then((c) => {
            nextCommentCache = c;
            if (c.currentPid) processPidResponse(c.currentPid);
        });
}
```

The client calls `getNextComment` after each vote, caches the response, and displays it. The client has no knowledge of the routing strategy — it simply requests and displays whatever the server returns.
