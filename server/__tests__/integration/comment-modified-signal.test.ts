/**
 * Moderating a comment must leave a signal the math engines can find.
 *
 * Both engines discover moderation with a strict watermark comparison and
 * nothing else:
 *   - Clojure `math/src/polismath/components/postgres.clj` `mod-poll`:
 *       SELECT * FROM comments WHERE modified > last-mod-timestamp
 *   - Python  `delphi/polismath/database/postgres.py` `poll_moderation_since`:
 *       SELECT zid, tid, modified, mod, is_meta FROM comments
 *        WHERE modified > :since ORDER BY zid, tid, modified
 * Each advances its watermark to the maximum `modified` it saw.
 *
 * `comments.modified` has an INSERT default of `now_as_millis()` and no update
 * trigger (`server/postgres/migrations/000000_initial.sql`), so before this
 * branch the moderation UPDATEs left it at the comment's creation time. A
 * comment moderated after the poller had already passed its creation timestamp
 * therefore produced no discoverable event at all: the engine kept scoring the
 * old moderation state until an unrelated full reload of that conversation.
 *
 * These tests exercise the two HTTP moderation writes against a real database
 * and then replay the Python poller's own query to prove the change is now
 * discoverable. The third write site — the `lang`/`lang_confidence` backfill in
 * `src/server.ts` — only runs at process start under
 * `Config.backfillCommentLangDetection`, so it is covered by the source scan in
 * `__tests__/unit/commentsModifiedStamp.test.ts` instead.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";

import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
  wait,
} from "../setup/api-test-helpers";
import pg from "../../src/db/pg-query";

// `now_as_millis()` truncates to whole milliseconds and the pollers compare
// strictly, so a write in the same millisecond as the watermark is genuinely
// undiscoverable. Give the clock room to move before every moderation so the
// assertions test the fix rather than the scheduler.
const CLOCK_MARGIN_MS = 25;

interface CommentRow {
  tid: number;
  modified: string | number;
  mod: number;
  active: boolean;
  is_meta: boolean;
}

describe("comment moderation advances comments.modified", () => {
  let conversationId: string;
  let commentIds: number[];
  let zid: number;
  let ownerAgent: any;

  const readComments = async (): Promise<Map<number, CommentRow>> => {
    const rows = (await pg.queryP_readOnly(
      "select tid, modified, mod, active, is_meta from comments where zid = ($1);",
      [zid]
    )) as CommentRow[];
    return new Map(rows.map((row) => [Number(row.tid), row]));
  };

  const modifiedOf = async (tid: number): Promise<number> => {
    const row = (await readComments()).get(tid);
    expect(row).toBeDefined();
    return Number(row?.modified);
  };

  /** The highest `modified` in this conversation — a poller watermark that has
   * already swept every one of these comments. */
  const watermark = async (): Promise<number> => {
    const values = [...(await readComments()).values()].map((row) =>
      Number(row.modified)
    );
    expect(values.length).toBeGreaterThan(0);
    return Math.max(...values);
  };

  /** `poll_moderation_since` from `delphi/polismath/database/postgres.py`,
   * verbatim in shape: global across conversations, strict `>`. */
  const pollModerationSince = async (since: number): Promise<CommentRow[]> =>
    (await pg.queryP_readOnly(
      `select zid, tid, modified, mod, is_meta
         from comments
        where modified > ($1)
        order by zid, tid, modified`,
      [since]
    )) as CommentRow[];

  const moderate = async (
    tid: number,
    body: { active: boolean; mod: number; is_meta: boolean }
  ) => {
    await wait(CLOCK_MARGIN_MS);
    return ownerAgent.put("/api/v3/comments").send({
      conversation_id: conversationId,
      tid,
      velocity: 1,
      ...body,
    });
  };

  beforeAll(async () => {
    const convo = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 3,
    });
    conversationId = convo.conversationId;
    commentIds = convo.commentIds;

    const { agent } = await getJwtAuthenticatedAgent(convo.testUser);
    ownerAgent = agent;

    const zidRows = (await pg.queryP_readOnly(
      "select zid from zinvites where zinvite = ($1) limit 1;",
      [conversationId]
    )) as Array<{ zid: number }>;
    zid = zidRows?.[0]?.zid;
    expect(typeof zid).toBe("number");
  });

  test("every fixture comment has a usable timestamp to move", async () => {
    // The pollers' strict `>` predicate excludes NULLs outright, so a row with
    // no timestamp is invisible however it is moderated. Pin that the rows
    // these tests work on start with real values.
    for (const row of (await readComments()).values()) {
      expect(Number.isFinite(Number(row.modified))).toBe(true);
      expect(Number(row.modified)).toBeGreaterThan(0);
    }
  });

  describe("PUT /api/v3/comments", () => {
    test("rejecting a comment moves its modified forward", async () => {
      const tid = commentIds[0];
      const before = await modifiedOf(tid);

      const response = await moderate(tid, {
        active: true,
        mod: -1,
        is_meta: false,
      });
      expect(response.status).toBe(200);

      const after = await readComments();
      expect(after.get(tid)?.mod).toBe(-1);
      expect(Number(after.get(tid)?.modified)).toBeGreaterThan(before);
    });

    test("accepting the same comment again moves it forward again", async () => {
      // Re-moderation is the case that used to be undiscoverable: the row's
      // timestamp was already behind the watermark by then.
      const tid = commentIds[0];
      const before = await modifiedOf(tid);

      const response = await moderate(tid, {
        active: true,
        mod: 1,
        is_meta: false,
      });
      expect(response.status).toBe(200);

      const after = await readComments();
      expect(after.get(tid)?.mod).toBe(1);
      expect(Number(after.get(tid)?.modified)).toBeGreaterThan(before);
    });

    test("a change to active or is_meta alone is also stamped", async () => {
      const tid = commentIds[1];
      const before = await modifiedOf(tid);

      const response = await moderate(tid, {
        active: false,
        mod: 0,
        is_meta: true,
      });
      expect(response.status).toBe(200);

      const after = await readComments();
      expect(after.get(tid)?.active ?? false).toBe(false);
      expect(after.get(tid)?.is_meta).toBe(true);
      expect(Number(after.get(tid)?.modified)).toBeGreaterThan(before);
    });

    test("comments the request did not name keep their timestamps", async () => {
      // The stamp must not turn one moderation into a conversation-wide
      // reprocessing signal.
      const untouched = commentIds[2];
      const before = await modifiedOf(untouched);

      const response = await moderate(commentIds[0], {
        active: true,
        mod: -1,
        is_meta: false,
      });
      expect(response.status).toBe(200);

      expect(await modifiedOf(untouched)).toBe(before);
    });
  });

  describe("POST /api/v3/topicMod/moderate", () => {
    test("comment_ids moderation stamps every comment it actually moderated", async () => {
      const targeted = [commentIds[1], commentIds[2]];
      const before = await readComments();
      const untouched = commentIds[0];
      const untouchedBefore = Number(before.get(untouched)?.modified);

      await wait(CLOCK_MARGIN_MS);
      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: targeted,
        action: "reject",
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty(
        "comments_moderated",
        targeted.length
      );

      const after = await readComments();
      for (const tid of targeted) {
        expect(after.get(tid)?.mod).toBe(-1);
        expect(Number(after.get(tid)?.modified)).toBeGreaterThan(
          Number(before.get(tid)?.modified)
        );
      }
      expect(Number(after.get(untouched)?.modified)).toBe(untouchedBefore);
    });

    test("an id matching no comment stamps nothing", async () => {
      const before = await readComments();

      await wait(CLOCK_MARGIN_MS);
      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: [999999],
        action: "accept",
      });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("comments_moderated", 0);

      const after = await readComments();
      for (const [tid, row] of before) {
        expect(Number(after.get(tid)?.modified)).toBe(Number(row.modified));
      }
    });
  });

  describe("regression: the poller's own query finds a re-moderated comment", () => {
    test("modified > watermark returns a comment moderated after the sweep", async () => {
      const tid = commentIds[0];

      // Stand where a poller stands after it has already swept this
      // conversation: its watermark is the newest timestamp in the table for
      // these comments, so `modified > since` currently excludes all of them.
      const since = await watermark();
      const beforeModeration = await pollModerationSince(since);
      expect(
        beforeModeration.filter((row) => Number(row.tid) === tid)
      ).toHaveLength(0);

      const response = await moderate(tid, {
        active: true,
        mod: 1,
        is_meta: false,
      });
      expect(response.status).toBe(200);

      // This is the assertion the bug failed: before the fix the row's
      // `modified` stayed at its creation time, so the poller's next sweep
      // returned nothing and the engine kept the stale moderation state.
      const discovered = await pollModerationSince(since);
      const found = discovered.filter((row) => Number(row.tid) === tid);
      expect(found).toHaveLength(1);
      expect(found[0].mod).toBe(1);
      expect(Number(found[0].modified)).toBeGreaterThan(since);
    });

    test("a topic moderation write is discoverable the same way", async () => {
      const tid = commentIds[2];
      const since = await watermark();
      expect(
        (await pollModerationSince(since)).filter(
          (row) => Number(row.tid) === tid
        )
      ).toHaveLength(0);

      await wait(CLOCK_MARGIN_MS);
      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: [tid],
        action: "meta",
      });
      expect(response.status).toBe(200);

      const found = (await pollModerationSince(since)).filter(
        (row) => Number(row.tid) === tid
      );
      expect(found).toHaveLength(1);
      expect(found[0].is_meta).toBe(true);
    });

    test("the watermark a poller would take from the sweep clears the row", async () => {
      // The poller advances `since` to max(modified) of what it just read, so
      // a stamped row must not keep re-appearing on every subsequent sweep.
      const tid = commentIds[1];
      const since = await watermark();

      const response = await moderate(tid, {
        active: true,
        mod: -1,
        is_meta: false,
      });
      expect(response.status).toBe(200);

      const sweep = await pollModerationSince(since);
      expect(sweep.some((row) => Number(row.tid) === tid)).toBe(true);

      const advanced = Math.max(...sweep.map((row) => Number(row.modified)));
      const next = await pollModerationSince(advanced);
      expect(next.some((row) => Number(row.tid) === tid)).toBe(false);
    });
  });
});
