// Page U4, "What people are talking about": the most active conversations of
// the last 7 days, with their topic and Delphi topic names.
//
// Content threshold (ruling R2, OPS_MIN_VOTERS_FOR_TEXT, default 20): a
// conversation is named only when it had at least that many distinct voters
// in the window. Below it the conversation is counted, never named, and its
// topic is never read: the detail statement is asked only for the named zids.
// What is shown is the conversation topic its owner wrote (shown to every
// participant) and Delphi's LLM topic labels; never an owner, an author or a
// participant.
//
// Statements:
//   WINDOW_VOTERS_SQL  votes in the window per conversation; votes_created_idx.
//   DETAIL_SQL         topic and totals for the named zids only; the
//                      conversations primary key and comments_zid_idx.

import type { OpsQuery } from "./guardedRead";
import type { TopicNames } from "./delphiTopicNames";
import { OpsRow, toCount } from "./types";

export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NAMED = 15;
const MAX_TOPIC_LENGTH = 300;

// $1 = window start (epoch ms).
export const WINDOW_VOTERS_SQL = `
SELECT zid, count(*) AS votes, count(DISTINCT pid) AS voters
FROM votes
WHERE created >= $1
GROUP BY zid`;

// $1 = the named zids.
export const DETAIL_SQL = `
SELECT c.zid, c.topic, c.participant_count, c.is_active,
       (SELECT count(*) FROM comments k WHERE k.zid = c.zid) AS statements
FROM conversations c
WHERE c.zid = ANY($1::int[])`;

export type WindowCount = { zid: number; votes: number; voters: number };

export type ActiveSplit = {
  named: WindowCount[];
  // At or above the threshold but past the MAX_NAMED cut.
  unlistedAbove: { conversations: number; voters: number };
  // Below the threshold: counted only.
  below: { conversations: number; voters: number };
};

export function toWindowCounts(raw: Record<string, unknown>[]): WindowCount[] {
  return raw.map((r) => ({
    zid: toCount(r.zid),
    votes: toCount(r.votes),
    voters: toCount(r.voters),
  }));
}

/**
 * Split the window's conversations into the ones that may be named (at least
 * minVoters voters, top MAX_NAMED by votes, then by voters, then by zid) and
 * the counted rest. Pure.
 */
export function splitActive(
  counts: WindowCount[],
  minVoters: number,
  maxNamed = MAX_NAMED
): ActiveSplit {
  const eligible = counts
    .filter((c) => c.voters >= minVoters)
    .sort((a, b) => b.votes - a.votes || b.voters - a.voters || a.zid - b.zid);
  const named = eligible.slice(0, maxNamed);
  const rest = eligible.slice(maxNamed);
  const small = counts.filter((c) => c.voters < minVoters);
  const sum = (xs: WindowCount[]) => xs.reduce((n, c) => n + c.voters, 0);
  return {
    named,
    unlistedAbove: { conversations: rest.length, voters: sum(rest) },
    below: { conversations: small.length, voters: sum(small) },
  };
}

export async function readActive(
  query: OpsQuery,
  nowMs: number,
  minVoters: number
): Promise<ActiveSplit> {
  const raw = await query(WINDOW_VOTERS_SQL, [nowMs - WINDOW_MS]);
  return splitActive(toWindowCounts(raw), minVoters);
}

export function cleanTopic(value: unknown): string {
  if (typeof value !== "string") return "(no topic)";
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "(no topic)";
  return text.length > MAX_TOPIC_LENGTH
    ? `${text.slice(0, MAX_TOPIC_LENGTH - 1)}…`
    : text;
}

export function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The sentence under the table about what was not named. */
export function thresholdNote(split: ActiveSplit, minVoters: number): string {
  const parts: string[] = [];
  if (split.unlistedAbove.conversations > 0) {
    parts.push(
      `${plural(
        split.unlistedAbove.conversations,
        "more conversation",
        "more conversations"
      )} above the threshold (${plural(
        split.unlistedAbove.voters,
        "voter",
        "voters"
      )}) not listed`
    );
  }
  parts.push(
    `${plural(
      split.below.conversations,
      "conversation",
      "conversations"
    )} with fewer than ${minVoters} voters in the window (${plural(
      split.below.voters,
      "voter",
      "voters"
    )} between them) counted but not named`
  );
  return `${parts.join(
    "; "
  )}. Voters are distinct participants per conversation.`;
}

/** One row per named conversation, in the split's order. Pure. */
export function shapeTopics(
  split: ActiveSplit,
  details: Record<string, unknown>[],
  names: TopicNames
): OpsRow[] {
  const byZid = new Map<number, Record<string, unknown>>();
  for (const d of details) byZid.set(toCount(d.zid), d);
  return split.named
    .filter((c) => byZid.has(c.zid))
    .map((c) => {
      const d = byZid.get(c.zid) as Record<string, unknown>;
      const delphi = names.get(c.zid);
      return {
        topic: cleanTopic(d.topic),
        delphi_topics: delphi === undefined ? [] : delphi,
        voters: c.voters,
        votes: c.votes,
        participants: toCount(d.participant_count ?? 0),
        statements: toCount(d.statements),
        status: d.is_active ? "Open" : "Closed",
      };
    });
}

export async function readDetails(
  query: OpsQuery,
  zids: number[]
): Promise<Record<string, unknown>[]> {
  if (zids.length === 0) return [];
  return query(DETAIL_SQL, [zids]);
}
