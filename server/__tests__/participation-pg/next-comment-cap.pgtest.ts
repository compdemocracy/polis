/** Ordinary next-comment routing draws from every eligible unvoted comment,
 * not only the oldest 999. The plain comment list (GET /api/v3/comments with
 * no limit) keeps its default of 999 rows, and its random ordering is
 * unchanged.
 *
 * Generated data only. Needs DATABASE_URL (superuser, migrated); see
 * scripts/test-delphi-result-reads.sh.
 */
import { Client } from "pg";
import { getComments, getNextCommentCandidates } from "../../src/comment";
import {
  checkInitialComment,
  getNextComment,
  getNextTopicalComment,
} from "../../src/nextComment";
import {
  semanticToStorage,
  storageToSemantic,
} from "../../src/votes/convention";
import { onParticipationPools } from "../../src/db/participation-scope";
import {
  conversation,
  postgres,
  publish,
  ENV,
  SCOPE,
} from "../delphi-results-pg/support";

const ZID = 9650,
  PID = 0,
  COUNT = 1200;
const topicKey = "00000000-0000-4000-8000-000000009650#0#0";
let db: Client;
const sequence = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => start + i);
const participating = <T>(work: () => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    onParticipationPools(undefined, undefined, () => {
      work().then(resolve, reject);
    });
  });
// The plain comment list, as GET /api/v3/comments reads it.
const listed = (extra = {}) =>
  participating(() =>
    getComments({ zid: ZID, not_voted_by_pid: PID, ...extra })
  );
// The ordinary next-comment draw's candidates.
const routed = (extra = {}) =>
  participating(() =>
    getNextCommentCandidates({ zid: ZID, not_voted_by_pid: PID, ...extra })
  );
const next = (without?: number[]) =>
  participating(() => getNextComment(ZID, PID, without));
const ids = (rows: { tid: number }[]) => rows.map((r) => r.tid);
async function vote(first: number, last: number) {
  const stored = semanticToStorage("agree");
  await db.query(
    `INSERT INTO votes(zid,pid,tid,vote)
    SELECT $1,$2,t,$3 FROM generate_series($4::int,$5::int) t`,
    [ZID, PID, stored, first, last]
  );
  const row = (
    await db.query(
      "SELECT vote FROM votes_latest_unique WHERE zid=$1 AND pid=$2 AND tid=$3",
      [ZID, PID, first]
    )
  ).rows[0];
  expect(storageToSemantic(row.vote)).toBe("agree");
}

beforeAll(async () => {
  process.env.TOPICAL_COMMENT_RATIO = "0";
  process.env.DELPHI_RESULT_BACKEND = "postgres";
  process.env.DELPHI_RESULT_ENV = ENV;
  process.env.DELPHI_RESULT_SCOPE = SCOPE;
  db = await postgres();
  await conversation(db, ZID);
  await db.query(
    "UPDATE conversations SET strict_moderation=false, prioritize_seed=false WHERE zid=$1",
    [ZID]
  );
  // Explicit monotonically increasing timestamps make the created order
  // deterministic. Replica mode bypasses number allocation only for generated
  // comments/participants, never for votes.
  await db.query("SET session_replication_role = replica");
  try {
    await db.query("DELETE FROM comments WHERE zid=$1", [ZID]);
    await db.query(
      "INSERT INTO participants(zid,pid,uid) VALUES($1,$2,$1) ON CONFLICT(zid,pid) DO NOTHING",
      [ZID, PID]
    );
    await db.query(
      `INSERT INTO comments(zid,pid,uid,tid,created,txt,mod,active,velocity,is_seed)
      SELECT $1,$2,$1,t,1700000000000::bigint+t,'generated comment ' || t,0,true,1,false
      FROM generate_series(0,$3::int-1) t`,
      [ZID, PID, COUNT]
    );
  } finally {
    await db.query("SET session_replication_role = origin");
  }
  await publish(db, {
    zid: ZID,
    families: {
      Delphi_CommentClustersLLMTopicNames: [
        {
          conversation_id: { S: String(ZID) },
          topic_key: { S: topicKey },
          layer_id: { N: "0" },
          cluster_id: { N: "0" },
        },
      ],
      Delphi_CommentHierarchicalClusterAssignments: sequence(1100, 100).map(
        (t) => ({
          conversation_id: { S: String(ZID) },
          comment_id: { N: String(t) },
          layer0_cluster_id: { N: "0" },
        })
      ),
    },
  });
  await db.query(
    `INSERT INTO topic_agenda_selections(zid,pid,archetypal_selections,total_selections)
    VALUES($1,$2,$3,1) ON CONFLICT(zid,pid) DO UPDATE SET archetypal_selections=EXCLUDED.archetypal_selections`,
    [ZID, PID, JSON.stringify([{ topic_key: topicKey }])]
  );
});
beforeEach(async () => {
  await db.query("DELETE FROM votes WHERE zid=$1", [ZID]);
  await db.query("DELETE FROM votes_latest_unique WHERE zid=$1", [ZID]);
  await db.query("UPDATE comments SET is_seed=false WHERE zid=$1", [ZID]);
  await db.query(
    "UPDATE conversations SET prioritize_seed=false WHERE zid=$1",
    [ZID]
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db?.end();
});

test("every eligible comment enters the ordinary draw; the plain list still stops at 999", async () => {
  expect(ids(await routed())).toEqual(sequence(0, COUNT));
  expect(ids(await listed())).toEqual(sequence(0, 999));
  jest.spyOn(Math, "random").mockReturnValue(0.999999);
  const last = await next();
  expect(last.tid).toBe(1199);
  expect(last.remaining).toBe(COUNT);
  expect(last.total).toBe(COUNT);
  await vote(0, 0);
  expect(ids(await routed())).toEqual(sequence(1, COUNT - 1));
  expect((await next()).tid).toBe(1199);
  jest.spyOn(Math, "random").mockReturnValue(0);
  expect((await next()).tid).toBe(1);
  await vote(1, 1198);
  expect(ids(await routed())).toEqual([1199]);
  expect((await next()).tid).toBe(1199);
  await vote(1199, 1199);
  expect(await routed()).toEqual([]);
  expect(await next()).toBeNull();
  process.stdout.write(
    "DRAW: fresh=0..1199 (near-1 draw 1199); after 1 vote=1..1199; plain list=0..998\n"
  );
});

test("the offered comment has the plain list's columns and key order", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0.5);
  const offered = (await next()) as unknown as Record<string, unknown>;
  expect(offered.tid).toBe(600);
  expect(offered.randomN).toBe(0.5 * COUNT);
  const [row] = await participating(() =>
    getComments({ zid: ZID, tids: [600] })
  );
  expect(Object.keys(offered)).toEqual([
    ...Object.keys(row),
    "randomN",
    "remaining",
    "total",
    "translations",
  ]);
  for (const key of Object.keys(row)) {
    expect(offered[key]).toEqual((row as Record<string, unknown>)[key]);
  }
});

test("random ordering of the plain list happens before its 999 default", async () => {
  const a = ids(await listed({ random: true }));
  const b = ids(await listed({ random: true }));
  expect(a).toHaveLength(999);
  expect(a.some((t) => t >= 999)).toBe(true);
  expect([...a].sort()).not.toEqual([...b].sort());
  await vote(0, 200);
  expect(ids(await listed({ random: true })).sort((x, y) => x - y)).toEqual(
    sequence(201, 999)
  );
});

test("topical selection reaches its topic; exhaustion falls back to every eligible comment", async () => {
  const topical = () => participating(() => getNextTopicalComment(ZID, PID));
  const first = await topical();
  expect(first.tid).toBeGreaterThanOrEqual(1100);
  await vote(1100, 1198);
  expect((await topical()).tid).toBe(1199);
  await vote(1199, 1199);
  jest.spyOn(Math, "random").mockReturnValue(0.999999);
  expect((await topical()).tid).toBe(1099);
  process.stdout.write(
    `TOPICAL: fresh=${first.tid}; after 99 topical votes=1199; after exhaustion fallback=1099\n`
  );
});

test("seed-first random order of the plain list is unchanged", async () => {
  await db.query("UPDATE conversations SET prioritize_seed=true WHERE zid=$1", [
    ZID,
  ]);
  await db.query("UPDATE comments SET is_seed=true WHERE zid=$1 AND tid<1000", [
    ZID,
  ]);
  expect((await listed({ random: true })).every((r) => r.tid < 1000)).toBe(
    true
  );
  expect((await listed({ random: true, limit: 1 }))[0].tid).toBeLessThan(1000);
  await vote(0, 1);
  const window = await listed({ random: true });
  expect(window).toHaveLength(999);
  expect(window.filter((r) => r.tid >= 1000)).toHaveLength(1);
  // The ordinary draw has no seed-first order: it is created order, weighted.
  expect(ids(await routed())).toEqual(sequence(2, COUNT - 2));
});

test("without excludes before the draw and an initial tid is offered directly", async () => {
  const without = sequence(0, 201);
  expect(ids(await routed({ withoutTids: without }))).toEqual(
    sequence(201, 999)
  );
  jest.spyOn(Math, "random").mockReturnValue(0);
  expect((await next(without)).tid).toBe(201);
  const initial = await participating(() =>
    checkInitialComment(ZID, PID, 1199)
  );
  expect(initial.status).toBe("eligible");
  expect(initial.comment.tid).toBe(1199);
});
