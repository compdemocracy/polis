// Page U5, "What consensus they found", for the conversations the topics page
// names (the same window and the same OPS_MIN_VOTERS_FOR_TEXT threshold).
//
// Everything is read from the published math in math_main.data for one
// math_env label (MATH_LABEL, "python", the label production serves), and
// read the way the report (client-report) reads it:
//
//   - Group sizes: group-votes[gid]["n-members"]; participants in the
//     analysis = their sum (client-report/src/components/app.jsx:452-456,
//     lists/participantGroup.jsx:31).
//   - Common ground: statements ranked by the normalized group consensus the
//     report sorts "Group-informed Consensus" by: for each group that voted on
//     the statement, (A + 1) / (A + D + 2) from group-votes[gid].votes[tid],
//     averaged over those groups (client-report/src/util/normalizeConsensus.js
//     normalizeGroupConsensus; used at app.jsx:557-560 and
//     lists/allCommentsModeratedIn.jsx:11). The raw group-aware-consensus[tid]
//     is shown beside it.
//   - What sets each group apart: the first repness[gid] entry whose
//     "repful-for" is "agree", in the order the math emits them
//     (app.jsx:505-518 builds repfulAgreeTidsByGroup the same way), with its
//     p-success, n-success and n-trials.
//
// Statement text is read only for the chosen tids and only if the statement
// is visible to participants: active, not meta, and mod >= 1 under strict
// moderation or mod >= 0 otherwise (the rule of get_visible_comments,
// server/postgres/migrations/000000_initial.sql:558-559). A statement that is
// not visible is skipped and the next candidate taken.
//
// The math blob is read again only when math_tick has advanced: a cheap
// (zid, math_tick) read comes first, on math_main's unique (zid, math_env).

import type { OpsQuery } from "./guardedRead";
import { readActive } from "./topics";
import { cleanTopic } from "./topics";
import { OpsRow, toCount, toNumberOrNull } from "./types";

export const MATH_LABEL = "python";
export const COMMON_GROUND_SHOWN = 3;
const COMMON_GROUND_CANDIDATES = 10;
const GROUP_CANDIDATES = 5;
const MAX_STATEMENT_LENGTH = 500;
// client-report/src/components/globals.js groupLabels.
const GROUP_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

export const TICKS_SQL = `
SELECT zid, math_tick FROM math_main
WHERE zid = ANY($1::int[]) AND math_env = $2`;

export const MATH_SQL = `
SELECT zid, math_tick,
       data->'group-votes'           AS group_votes,
       data->'group-aware-consensus' AS gac,
       data->'repness'               AS repness
FROM math_main
WHERE zid = ANY($1::int[]) AND math_env = $2`;

export const TOPIC_SQL = `
SELECT zid, topic FROM conversations WHERE zid = ANY($1::int[])`;

// $1 = zids, $2 = tids, pairwise.
export const VISIBLE_TEXT_SQL = `
SELECT k.zid, k.tid, k.txt
FROM comments k
JOIN conversations c ON c.zid = k.zid
WHERE (k.zid, k.tid) IN (SELECT * FROM unnest($1::int[], $2::int[]))
  AND k.active
  AND NOT k.is_meta
  AND k.mod >= (CASE WHEN c.strict_moderation THEN 1 ELSE 0 END)`;

type GroupVotes = Record<
  string,
  {
    "n-members"?: unknown;
    votes?: Record<string, { A?: unknown; D?: unknown }>;
  }
>;

export type CommonGround = {
  tid: number;
  normalized: number;
  raw: number | null;
};

export type GroupFinding = {
  gid: number;
  label: string;
  members: number;
  candidates: {
    tid: number;
    p_success: number | null;
    n_success: number | null;
    n_trials: number | null;
    repness: number | null;
  }[];
};

export type MathSummary = {
  participants: number;
  groups: GroupFinding[];
  common: CommonGround[];
};

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

/**
 * normalizeGroupConsensus from client-report/src/util/normalizeConsensus.js,
 * ported line for line: the mean over groups that voted on tid of
 * (A + 1) / (A + D + 2); 0.5 when no group did.
 */
export function normalizeGroupConsensus(
  groupVotes: GroupVotes | null | undefined,
  tid: number | string
): number {
  if (!groupVotes) return 0.5;
  let sum = 0;
  let groupCount = 0;
  for (const gid in groupVotes) {
    const votes = groupVotes[gid]?.votes?.[String(tid)];
    if (!votes) continue;
    const agrees = num(votes.A) || 0;
    const disagrees = num(votes.D) || 0;
    sum += (agrees + 1) / (agrees + disagrees + 2);
    groupCount += 1;
  }
  if (groupCount === 0) return 0.5;
  return sum / groupCount;
}

function groupLabel(gid: number) {
  return `Group ${GROUP_LABELS[gid] ?? gid + 1}`;
}

/**
 * Shape one conversation's published math. Returns null for the empty case
 * (no groups yet: group-votes empty or repness {}), which the page reports as
 * "no opinion groups yet" rather than an error. Pure.
 */
export function summarizeMath(row: {
  group_votes: unknown;
  gac: unknown;
  repness: unknown;
}): MathSummary | null {
  const groupVotes = asObject(row.group_votes) as GroupVotes;
  const repness = asObject(row.repness);
  const gac = asObject(row.gac);
  const gids = Object.keys(groupVotes)
    .map(Number)
    .filter((g) => Number.isInteger(g) && g >= 0)
    .sort((a, b) => a - b);
  if (gids.length === 0 || Object.keys(repness).length === 0) return null;

  const groups: GroupFinding[] = gids.map((gid) => {
    const entries = Array.isArray(repness[String(gid)])
      ? (repness[String(gid)] as Record<string, unknown>[])
      : [];
    return {
      gid,
      label: groupLabel(gid),
      members: toCount(num(groupVotes[String(gid)]?.["n-members"])),
      candidates: entries
        .filter((e) => e && e["repful-for"] === "agree")
        .filter((e) => Number.isInteger(Number(e.tid)))
        .slice(0, GROUP_CANDIDATES)
        .map((e) => ({
          tid: Number(e.tid),
          p_success: toNumberOrNull(e["p-success"]),
          n_success: toNumberOrNull(e["n-success"]),
          n_trials: toNumberOrNull(e["n-trials"]),
          repness: toNumberOrNull(e.repness),
        })),
    };
  });

  // Every tid any group voted on, as enrichMathWithNormalizedConsensus does.
  const tids = new Set<number>();
  for (const gid of gids) {
    for (const tid of Object.keys(groupVotes[String(gid)]?.votes || {})) {
      const n = Number(tid);
      if (Number.isInteger(n)) tids.add(n);
    }
  }
  const common = [...tids]
    .map((tid) => ({
      tid,
      normalized: normalizeGroupConsensus(groupVotes, tid),
      raw: toNumberOrNull(gac[String(tid)]),
    }))
    .sort(
      (a, b) =>
        b.normalized - a.normalized ||
        (b.raw ?? -1) - (a.raw ?? -1) ||
        a.tid - b.tid
    )
    .slice(0, COMMON_GROUND_CANDIDATES);

  return {
    participants: groups.reduce((n, g) => n + g.members, 0),
    groups,
    common,
  };
}

function cleanStatement(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_STATEMENT_LENGTH
    ? `${text.slice(0, MAX_STATEMENT_LENGTH - 1)}…`
    : text;
}

function fixed(n: number | null, digits: number) {
  return n === null ? "n/a" : n.toFixed(digits);
}

export type ConversationMath =
  | { zid: number; topic: string; state: "ok"; summary: MathSummary }
  | { zid: number; topic: string; state: "no_math" | "no_groups" };

/**
 * Rows for the grouped table: per conversation, up to three common-ground
 * statements, then one distinctive statement per group. `texts` maps
 * "zid:tid" to visible statement text; a tid absent from it is skipped. Pure.
 */
export function shapeConsensus(
  conversations: ConversationMath[],
  texts: Map<string, string>
): OpsRow[] {
  const rows: OpsRow[] = [];
  for (const c of conversations) {
    if (c.state !== "ok") {
      rows.push({
        conversation: c.topic,
        finding:
          c.state === "no_math"
            ? `No published math under "${MATH_LABEL}"`
            : "No opinion groups yet",
        statement: null,
        agree: null,
        detail: null,
      });
      continue;
    }
    const s = c.summary;
    const heading = `${c.topic} · ${s.participants.toLocaleString(
      "en-US"
    )} participants in ${s.groups.length} ${
      s.groups.length === 1 ? "group" : "groups"
    }`;
    let shown = 0;
    for (const cg of s.common) {
      if (shown >= COMMON_GROUND_SHOWN) break;
      const text = texts.get(`${c.zid}:${cg.tid}`);
      if (!text) continue;
      shown += 1;
      rows.push({
        conversation: heading,
        finding: `Common ground ${shown}`,
        statement: text,
        agree: cg.normalized,
        detail: `mean of per-group agree rates; group-aware consensus ${fixed(
          cg.raw,
          3
        )}`,
      });
    }
    for (const g of s.groups) {
      const pick = g.candidates.find((k) => texts.has(`${c.zid}:${k.tid}`));
      rows.push({
        conversation: heading,
        finding: `${g.label} · ${g.members.toLocaleString("en-US")} people`,
        statement: pick ? (texts.get(`${c.zid}:${pick.tid}`) as string) : null,
        agree: pick ? pick.p_success : null,
        detail: pick
          ? `${fixed(pick.n_success, 0)} of ${fixed(
              pick.n_trials,
              0
            )} in the group who voted on it agreed; repness ${fixed(
              pick.repness,
              2
            )}`
          : "no distinctive agree statement",
      });
    }
  }
  return rows;
}

/** Remembers each conversation's summary until its math_tick advances. */
export class MathMemo {
  private entries = new Map<
    number,
    { tick: number; summary: MathSummary | null }
  >();

  get(zid: number, tick: number) {
    const e = this.entries.get(zid);
    return e && e.tick === tick ? e : undefined;
  }

  set(zid: number, tick: number, summary: MathSummary | null) {
    this.entries.set(zid, { tick, summary });
  }

  keepOnly(zids: number[]) {
    const keep = new Set(zids);
    for (const zid of this.entries.keys()) {
      if (!keep.has(zid)) this.entries.delete(zid);
    }
  }
}

export async function readConsensus(
  query: OpsQuery,
  nowMs: number,
  minVoters: number,
  memo: MathMemo
): Promise<{
  rows: OpsRow[];
  named: number;
  split: Awaited<ReturnType<typeof readActive>>;
}> {
  const split = await readActive(query, nowMs, minVoters);
  const zids = split.named.map((c) => c.zid);
  memo.keepOnly(zids);
  if (zids.length === 0) return { rows: [], named: 0, split };

  const ticks = new Map<number, number>();
  for (const r of await query(TICKS_SQL, [zids, MATH_LABEL])) {
    ticks.set(toCount(r.zid), Number(r.math_tick));
  }
  const stale = zids.filter(
    (zid) => ticks.has(zid) && !memo.get(zid, ticks.get(zid) as number)
  );
  if (stale.length > 0) {
    for (const r of await query(MATH_SQL, [stale, MATH_LABEL])) {
      memo.set(toCount(r.zid), Number(r.math_tick), summarizeMath(r as any));
    }
  }

  const topics = new Map<number, string>();
  for (const r of await query(TOPIC_SQL, [zids])) {
    topics.set(toCount(r.zid), cleanTopic(r.topic));
  }

  const conversations: ConversationMath[] = zids.map((zid) => {
    const topic = topics.get(zid) || "(no topic)";
    const tick = ticks.get(zid);
    const entry = tick === undefined ? undefined : memo.get(zid, tick);
    if (!entry) return { zid, topic, state: "no_math" };
    if (!entry.summary) return { zid, topic, state: "no_groups" };
    return { zid, topic, state: "ok", summary: entry.summary };
  });

  const wanted = new Map<string, [number, number]>();
  for (const c of conversations) {
    if (c.state !== "ok") continue;
    const tids = [
      ...c.summary.common.map((cg) => cg.tid),
      ...c.summary.groups.flatMap((g) => g.candidates.map((k) => k.tid)),
    ];
    for (const tid of tids) wanted.set(`${c.zid}:${tid}`, [c.zid, tid]);
  }
  const pairs = [...wanted.values()];
  const texts = new Map<string, string>();
  if (pairs.length > 0) {
    const rows = await query(VISIBLE_TEXT_SQL, [
      pairs.map((p) => p[0]),
      pairs.map((p) => p[1]),
    ]);
    for (const r of rows) {
      const text = cleanStatement(r.txt);
      if (text) texts.set(`${toCount(r.zid)}:${toCount(r.tid)}`, text);
    }
  }
  return {
    rows: shapeConsensus(conversations, texts),
    named: zids.length,
    split,
  };
}
