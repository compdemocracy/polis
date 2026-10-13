import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import {
  newAgent,
  createConversation,
  createComment,
  initializeParticipant,
  initializeParticipantWithXid,
  submitVote,
  submitComment,
  getJwtAuthenticatedAgent,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { issueAnonymousJWT } from "../../src/auth/anonymous-jwt";
import { issueStandardUserJWT } from "../../src/auth/standard-user-jwt";
import { pool, closePool } from "../setup/db-test-helpers";

/**
 * Cross-conversation vote attribution — reproduction battery.
 *
 * Claim under test: a participant token minted for conversation X (carrying that
 * participant's pid) can be used to POST a vote to a *different* conversation Y,
 * and the vote is stored against whichever participant happens to hold that pid
 * number in Y — i.e. attributed to a different person.
 *
 * Why this is possible, traced through the request pipeline (origin/edge):
 *   - participant pids are assigned PER CONVERSATION starting at 0
 *     (trigger `pid_auto`, server/postgres/migrations/000000_initial.sql:891-905),
 *     so pid collisions across conversations are the norm, not the exception.
 *   - the vote route runs hybridAuthOptional -> resolves the REQUESTED conversation
 *     to req.p.zid -> ensureParticipant (server/app.ts:1226-1244).
 *   - the JWT extractor sets req.p.pid from the token and flags, but does not
 *     reject, a conversation mismatch (server/src/auth/jwt-utils.ts:297, 309-321).
 *   - ensureParticipant copies uid/pid into locals (ensure-participant.ts:383-384)
 *     BEFORE _handleJWTConversationMismatch nulls req.p.uid/req.p.pid
 *     (ensure-participant.ts:391, 92-152); the locals are never refreshed.
 *   - the nonnegative-pid fast path returns the stale pid unchanged
 *     (ensure-participant.ts:221-222), and it is written back to req.p
 *     (ensure-participant.ts:539-540).
 *   - handle_POST_votes inserts (pid, zid, tid, vote) with no uid/pid consistency
 *     check (server/src/routes/votes.ts:201-215, 70-72); the `votes` table has no
 *     (zid,pid) foreign key, so even a pid that does not exist in Y is accepted.
 *
 * The COMMENT route uses the same middleware but re-resolves pid against (zid,uid)
 * in the handler (server/src/routes/comments.ts:408-444), so it is expected NOT to
 * misattribute — it is included here as a control/comparison.
 *
 * The raw OIDC access token is also included as a control: it carries no pid and
 * sets no mismatch flag, so ensureParticipant resolves the pid fresh per
 * conversation (server/src/auth/jwt-middleware.ts extractUserFromJWT); it is
 * expected NOT to misattribute.
 *
 * STATUS: failing-first. Each reproduction assertion states the CORRECT behaviour
 * (a token for X must never cast a vote recorded under another person in Y). Where
 * the defect is live these assertions FAIL (red) on purpose; they are evidence, not
 * a passing regression. Every test also logs the exact stored rows for the record.
 * Votes are written ONLY through the real vote route (submitVote); nothing here
 * raw-inserts a vote value.
 */

const ATTACK_VOTE = -1; // storage convention: -1 = agree. Written via the route only.
const MAT_VOTE = 0; // pass/skip, used only to materialize victim participants.

// ---- DB inspection helpers (read-only) ----
async function zidOf(conversationId: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT zid FROM zinvites WHERE zinvite = $1 LIMIT 1",
    [conversationId]
  );
  if (!rows[0]) throw new Error(`no zid for conversation ${conversationId}`);
  return rows[0].zid;
}
async function uidOfPid(zid: number, pid: number): Promise<number | null> {
  const { rows } = await pool.query(
    "SELECT uid FROM participants WHERE zid = $1 AND pid = $2",
    [zid, pid]
  );
  return rows[0]?.uid ?? null;
}
async function pidOfUid(zid: number, uid: number): Promise<number | null> {
  const { rows } = await pool.query(
    "SELECT pid FROM participants WHERE zid = $1 AND uid = $2",
    [zid, uid]
  );
  return rows[0]?.pid ?? null;
}
async function maxPid(zid: number): Promise<number> {
  const { rows } = await pool.query(
    "SELECT COALESCE(MAX(pid), -1) AS m FROM participants WHERE zid = $1",
    [zid]
  );
  return rows[0].m;
}
/** All *latest* votes on a comment, joined to the owning participant's uid. */
async function latestVotesWithOwner(
  zid: number,
  tid: number
): Promise<{ pid: number; vote: number; uid: number | null }[]> {
  const { rows } = await pool.query(
    `SELECT v.pid, v.vote, p.uid
       FROM votes_latest_unique v
       LEFT JOIN participants p ON p.zid = v.zid AND p.pid = v.pid
      WHERE v.zid = $1 AND v.tid = $2
      ORDER BY v.pid`,
    [zid, tid]
  );
  return rows;
}
async function rawVoteRows(
  zid: number,
  pid: number,
  tid: number
): Promise<{ vote: number }[]> {
  const { rows } = await pool.query(
    "SELECT vote FROM votes WHERE zid = $1 AND pid = $2 AND tid = $3",
    [zid, pid, tid]
  );
  return rows;
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

async function agentWithToken(token: string) {
  const a = await newAgent();
  a.set("Authorization", `Bearer ${token}`);
  return a;
}

// ---- Shared owner (OIDC) for all conversations ----
async function makeOwner(poolIndex: number): Promise<{ agent: any; uid: number }> {
  const pu = getPooledTestUser(poolIndex);
  const { agent } = await getJwtAuthenticatedAgent({
    email: pu.email,
    hname: pu.name,
    password: pu.password,
  } as any);
  const ur = await agent.get("/api/v3/users");
  const uid = ur.body?.uid;
  // Clear any domain whitelist so anonymous participationInit is not domain-blocked.
  try {
    await agent
      .post("/api/v3/domainWhitelist")
      .send({ domain_whitelist: "" })
      .ok(() => true);
  } catch {
    /* best effort */
  }
  return { agent, uid };
}

/** Create a conversation with a materialize comment and an untouched attack comment. */
async function makeConversation(
  ownerAgent: any
): Promise<{ convId: string; zid: number; matTid: number; attackTid: number }> {
  const convId = await createConversation(ownerAgent, {
    is_active: true,
    is_anon: true,
    strict_moderation: false,
    profanity_filter: false,
  });
  // First createComment internally seeds a comment to vote on, then creates matTid.
  const matTid = await createComment(ownerAgent, convId, {
    conversation_id: convId,
    txt: `materialize target ${convId} ${Date.now()}`,
  } as any);
  const attackTid = await createComment(ownerAgent, convId, {
    conversation_id: convId,
    txt: `attack target ${convId} ${Date.now()}`,
  } as any);
  return { convId, zid: await zidOf(convId), matTid, attackTid };
}

/** Ensure conversation Y has a participant at pid === targetPid, owned by someone != aUid. */
async function ensureVictimAtPid(
  convY: string,
  zidY: number,
  targetPid: number,
  matTid: number
): Promise<number> {
  let guard = 0;
  while ((await maxPid(zidY)) < targetPid) {
    const { agent } = await initializeParticipant(convY);
    await submitVote(agent, {
      conversation_id: convY,
      tid: matTid,
      vote: MAT_VOTE,
    } as any);
    if (++guard > targetPid + 8) {
      throw new Error(`could not materialize a victim at pid ${targetPid}`);
    }
  }
  const uidB = await uidOfPid(zidY, targetPid);
  if (uidB == null) throw new Error(`no participant at pid ${targetPid} in Y`);
  return uidB;
}

/**
 * Run the shared cross-conversation vote assertion for a pid-carrying token kind.
 * `tokenA` is a valid token for conversation X carrying (uidA, pidA).
 */
async function assertVoteAttribution(opts: {
  kind: string;
  tokenA: string;
  uidA: number;
  pidA: number;
  convY: string;
  zidY: number;
  attackTid: number;
  uidB: number;
}) {
  const { kind, tokenA, uidA, pidA, convY, zidY, attackTid, uidB } = opts;

  const attacker = await agentWithToken(tokenA);
  const vr = await submitVote(attacker, {
    conversation_id: convY,
    tid: attackTid,
    vote: ATTACK_VOTE,
  } as any);

  const latest = await latestVotesWithOwner(zidY, attackTid);
  const raw = await rawVoteRows(zidY, pidA, attackTid);
  const aPidInY = await pidOfUid(zidY, uidA);
  const victimRows = latest.filter((r) => r.uid === uidB);
  const victimGotMyVote = victimRows.some((r) => r.vote === ATTACK_VOTE);

  // eslint-disable-next-line no-console
  console.log(
    `[VOTE/${kind}] POST /votes -> status ${vr.status}; ` +
      `A=(uid ${uidA}, pid ${pidA} in X); victim B=(uid ${uidB}, pid ${pidA} in Y); ` +
      `A's own pid in Y=${aPidInY}; ` +
      `latest votes on attack tid=${JSON.stringify(latest)}; ` +
      `raw votes at (Y, pid ${pidA}, tid)=${raw.length}`
  );

  // CORRECT behaviour (failing-first): a token for X must NEVER cast a vote that
  // is stored under another participant (the victim) in Y.
  expect({ kind, victimGotMyVote }).toEqual({ kind, victimGotMyVote: false });
}

describe("cross-conversation vote attribution (failing-first evidence; RED until fixed)", () => {
  let owner: { agent: any; uid: number };

  beforeAll(async () => {
    owner = await makeOwner(1);
  });

  afterAll(async () => {
    await closePool();
  });

  describe("anonymous participant token", () => {
    test("vote: token for X is recorded under the victim's pid in Y (should be rejected or A's own)", async () => {
      const X = await makeConversation(owner.agent);
      const { agent } = await initializeParticipant(X.convId);
      const vr = await submitVote(agent, {
        conversation_id: X.convId,
        tid: X.attackTid,
        vote: 1,
      } as any);
      const tokenA: string = vr.body?.auth?.token;
      expect(typeof tokenA).toBe("string");
      const claims = decodeJwt(tokenA);
      expect(claims.conversation_id).toBe(X.convId);
      const uidA = claims.uid as number;
      const pidA = claims.pid as number;

      const Y = await makeConversation(owner.agent);
      const uidB = await ensureVictimAtPid(Y.convId, Y.zid, pidA, Y.matTid);
      expect(uidB).not.toBe(uidA);

      await assertVoteAttribution({
        kind: "anonymous",
        tokenA,
        uidA,
        pidA,
        convY: Y.convId,
        zidY: Y.zid,
        attackTid: Y.attackTid,
        uidB,
      });
    });

    test("comment (control): re-resolves pid by (zid,uid), so it is attributed to A, not the victim", async () => {
      const X = await makeConversation(owner.agent);
      const { agent } = await initializeParticipant(X.convId);
      const vr = await submitVote(agent, {
        conversation_id: X.convId,
        tid: X.attackTid,
        vote: 1,
      } as any);
      const tokenA: string = vr.body?.auth?.token;
      const claims = decodeJwt(tokenA);
      const uidA = claims.uid as number;
      const pidA = claims.pid as number;

      const Y = await makeConversation(owner.agent);
      const uidB = await ensureVictimAtPid(Y.convId, Y.zid, pidA, Y.matTid);

      const attacker = await agentWithToken(tokenA);
      const txt = `anon cross-conv comment ${Date.now()}`;
      const cr = await submitComment(attacker, {
        conversation_id: Y.convId,
        txt,
      } as any);
      const { rows } = await pool.query(
        "SELECT pid, uid FROM comments WHERE zid = $1 AND txt = $2",
        [Y.zid, txt]
      );
      // eslint-disable-next-line no-console
      console.log(
        `[COMMENT/anonymous] POST /comments -> status ${cr.status}; stored=${JSON.stringify(
          rows
        )}; A uid=${uidA}, victim uid=${uidB}, stale pid=${pidA}`
      );
      expect(rows[0]?.uid).toBe(uidA);
      expect(rows[0]?.uid).not.toBe(uidB);
    });
  });

  describe("XID participant token", () => {
    test("vote: token for X is recorded under the victim's pid in Y (should be rejected or A's own)", async () => {
      const X = await makeConversation(owner.agent);
      const xid = `misattr-xid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const init = await initializeParticipantWithXid(X.convId, xid);
      const vr = await submitVote(init.agent, {
        conversation_id: X.convId,
        tid: X.attackTid,
        vote: 1,
        xid,
      } as any);
      const tokenA: string = vr.body?.auth?.token || init.token;
      expect(typeof tokenA).toBe("string");
      const claims = decodeJwt(tokenA);
      expect(claims.conversation_id).toBe(X.convId);
      expect(claims.xid_participant).toBe(true);
      const uidA = claims.uid as number;
      const pidA = claims.pid as number;

      const Y = await makeConversation(owner.agent);
      const uidB = await ensureVictimAtPid(Y.convId, Y.zid, pidA, Y.matTid);
      expect(uidB).not.toBe(uidA);

      await assertVoteAttribution({
        kind: "xid",
        tokenA,
        uidA,
        pidA,
        convY: Y.convId,
        zidY: Y.zid,
        attackTid: Y.attackTid,
        uidB,
      });
    });

    test("comment (control): attributed to A, not the victim", async () => {
      const X = await makeConversation(owner.agent);
      const xid = `misattr-xid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const init = await initializeParticipantWithXid(X.convId, xid);
      const vr = await submitVote(init.agent, {
        conversation_id: X.convId,
        tid: X.attackTid,
        vote: 1,
        xid,
      } as any);
      const tokenA: string = vr.body?.auth?.token || init.token;
      const claims = decodeJwt(tokenA);
      const uidA = claims.uid as number;
      const pidA = claims.pid as number;

      const Y = await makeConversation(owner.agent);
      const uidB = await ensureVictimAtPid(Y.convId, Y.zid, pidA, Y.matTid);

      const attacker = await agentWithToken(tokenA);
      const txt = `xid cross-conv comment ${Date.now()}`;
      const cr = await submitComment(attacker, {
        conversation_id: Y.convId,
        txt,
      } as any);
      const { rows } = await pool.query(
        "SELECT pid, uid FROM comments WHERE zid = $1 AND txt = $2",
        [Y.zid, txt]
      );
      // eslint-disable-next-line no-console
      console.log(
        `[COMMENT/xid] POST /comments -> status ${cr.status}; stored=${JSON.stringify(
          rows
        )}; A uid=${uidA}, victim uid=${uidB}, stale pid=${pidA}`
      );
      expect(rows[0]?.uid).toBe(uidA);
      expect(rows[0]?.uid).not.toBe(uidB);
    });
  });

  describe("standard-user (OIDC-derived participant) token", () => {
    // The standard-user participant JWT is minted by the server's own
    // issueStandardUserJWT(sub, conversationId, uid, pid). We obtain the real
    // (uid, pid) by having a real OIDC user participate in X, then mint the token
    // exactly as the server would. The oidc_sub string does not affect pid-based
    // attribution.
    test("vote: token for X is recorded under the victim's pid in Y (should be rejected or A's own)", async () => {
      const X = await makeConversation(owner.agent);
      const puA = getPooledTestUser(2);
      const { agent: oidcAgent } = await getJwtAuthenticatedAgent({
        email: puA.email,
        hname: puA.name,
        password: puA.password,
      } as any);
      await oidcAgent.get("/api/v3/users");
      await submitVote(oidcAgent, {
        conversation_id: X.convId,
        tid: X.attackTid,
        vote: 1,
      } as any);
      const uidA = (await oidcAgent.get("/api/v3/users")).body?.uid as number;
      const pidA = await pidOfUid(X.zid, uidA);
      expect(typeof uidA).toBe("number");
      expect(typeof pidA).toBe("number");

      const tokenA = issueStandardUserJWT(
        `misattr-sub-${Date.now()}`,
        X.convId,
        uidA,
        pidA as number
      );

      const Y = await makeConversation(owner.agent);
      const uidB = await ensureVictimAtPid(
        Y.convId,
        Y.zid,
        pidA as number,
        Y.matTid
      );
      expect(uidB).not.toBe(uidA);

      await assertVoteAttribution({
        kind: "standard-user",
        tokenA,
        uidA,
        pidA: pidA as number,
        convY: Y.convId,
        zidY: Y.zid,
        attackTid: Y.attackTid,
        uidB,
      });
    });
  });

  describe("raw OIDC access token (control: carries no pid)", () => {
    test("vote: resolves A's own participant in Y; must NOT land on the victim", async () => {
      const X = await makeConversation(owner.agent);
      const puA = getPooledTestUser(3);
      const { agent: oidcAgent } = await getJwtAuthenticatedAgent({
        email: puA.email,
        hname: puA.name,
        password: puA.password,
      } as any);
      await oidcAgent.get("/api/v3/users");
      await submitVote(oidcAgent, {
        conversation_id: X.convId,
        tid: X.attackTid,
        vote: 1,
      } as any);
      const uidA = (await oidcAgent.get("/api/v3/users")).body?.uid as number;
      const pidAInX = await pidOfUid(X.zid, uidA);

      const Y = await makeConversation(owner.agent);
      // Put a victim at the pid A happened to hold in X, to show OIDC does NOT reuse it.
      const uidB = await ensureVictimAtPid(
        Y.convId,
        Y.zid,
        pidAInX as number,
        Y.matTid
      );
      expect(uidB).not.toBe(uidA);

      // Same OIDC agent (raw bearer) votes in Y.
      const vr = await submitVote(oidcAgent, {
        conversation_id: Y.convId,
        tid: Y.attackTid,
        vote: ATTACK_VOTE,
      } as any);

      const latest = await latestVotesWithOwner(Y.zid, Y.attackTid);
      const aPidInY = await pidOfUid(Y.zid, uidA);
      const victimGotMyVote = latest.some(
        (r) => r.uid === uidB && r.vote === ATTACK_VOTE
      );
      // eslint-disable-next-line no-console
      console.log(
        `[VOTE/oidc] POST /votes -> status ${vr.status}; A uid=${uidA} (pid in X=${pidAInX}); ` +
          `A's own pid in Y=${aPidInY}; victim uid=${uidB} at pid ${pidAInX}; ` +
          `latest=${JSON.stringify(latest)}`
      );
      // Expected to PASS: OIDC is the control (no pid in token, resolved fresh).
      expect(victimGotMyVote).toBe(false);
    });
  });

  describe("stale pid that does not exist in Y (orphan vote)", () => {
    test("vote with a nonexistent pid: should be rejected; no FK means it is stored orphaned", async () => {
      const Y = await makeConversation(owner.agent);
      const bogusPid = 900000 + Math.floor(Math.random() * 90000);
      // A valid anon token for some conversation (owner's uid is a real user),
      // carrying a pid that does not exist in Y. conversation_id in the token is
      // set to a throwaway string so the mismatch path is exercised; uid is real.
      const tokenA = issueAnonymousJWT("not-a-real-conv-id", owner.uid, bogusPid);
      const attacker = await agentWithToken(tokenA);
      const vr = await submitVote(attacker, {
        conversation_id: Y.convId,
        tid: Y.attackTid,
        vote: ATTACK_VOTE,
      } as any);

      const orphan = await rawVoteRows(Y.zid, bogusPid, Y.attackTid);
      const ownerOfBogus = await uidOfPid(Y.zid, bogusPid);
      // eslint-disable-next-line no-console
      console.log(
        `[VOTE/orphan] POST /votes -> status ${vr.status}; bogus pid=${bogusPid}; ` +
          `orphan vote rows at (Y, bogus pid, tid)=${orphan.length}; ` +
          `participant at that pid in Y=${ownerOfBogus}`
      );
      // CORRECT behaviour (failing-first): a vote for a pid with no participant in
      // Y must not be stored.
      expect(orphan.length).toBe(0);
    });
  });
});
