import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
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
import { toWire } from "../setup/vote-wire";
import { issueAnonymousJWT } from "../../src/auth/anonymous-jwt";
import { issueStandardUserJWT } from "../../src/auth/standard-user-jwt";
import { pool, closePool } from "../setup/db-test-helpers";

/**
 * A participant token is scoped to the conversation it was issued in.
 *
 * Participant pids are assigned per conversation starting at 0 (trigger
 * `pid_auto`, server/postgres/migrations/000000_initial.sql), so the same pid
 * number names a different person in every conversation. A token issued in
 * conversation X carries X's (uid, pid). When that token is presented in a
 * different conversation Y, the server resolves the participant for Y itself:
 * the vote is recorded for the caller's own participant in Y (created on the
 * spot when there is none), never for whoever holds that pid number in Y, and
 * never for a pid that has no participant row.
 *
 * ensureParticipant (server/src/auth/ensure-participant.ts) reads the request's
 * uid/pid only after the conversation-mismatch handler has run, and a token for
 * another conversation never supplies this conversation's pid. A token used in
 * the conversation it was issued in takes exactly the path it always has.
 *
 * Cases:
 *   - same-conversation token (anonymous, XID, standard-user): votes as itself,
 *     creates no participant, is issued no new token;
 *   - cross-conversation token (anonymous, XID, standard-user): votes as a new
 *     participant in Y, not as the holder of the same pid in Y, not as an
 *     orphan pid, and the response carries a token for Y;
 *   - cross-conversation token whose pid has no participant in Y: no orphan row;
 *   - participationInit with a cross-conversation token shows nobody else's votes;
 *   - controls: the raw OIDC access token (carries no pid) and the comment route
 *     (re-resolves the pid by (zid, uid)) attribute to the caller.
 *
 * Votes are written only through the real vote route (submitVote); nothing here
 * writes a vote value directly. Each test logs the stored rows for the record.
 */

// The vote under test, on the wire. Nothing is identified by its value: the
// comment it is cast on is otherwise untouched, so the row is found by tid.
const VOTE_UNDER_TEST = toWire("agree");
// Used only to materialize other participants.
const MAT_VOTE = toWire("pass");

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

type Conversation = {
  convId: string;
  zid: number;
  matTid: number;
  voteTid: number;
};

type ParticipantToken = { token: string; uid: number; pid: number };

// ---- Shared owner (OIDC) for all conversations ----
async function makeOwner(
  poolIndex: number
): Promise<{ agent: any; uid: number }> {
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

/** A conversation with a comment to materialize on and an untouched comment to vote on. */
async function makeConversation(ownerAgent: any): Promise<Conversation> {
  const convId = await createConversation(ownerAgent, {
    is_active: true,
    is_anon: true,
    strict_moderation: false,
    profanity_filter: false,
  });
  const matTid = await createComment(ownerAgent, convId, {
    conversation_id: convId,
    txt: `materialize target ${convId} ${Date.now()}`,
  } as any);
  const voteTid = await createComment(ownerAgent, convId, {
    conversation_id: convId,
    txt: `vote target ${convId} ${Date.now()}`,
  } as any);
  return { convId, zid: await zidOf(convId), matTid, voteTid };
}

/** Ensure conversation Y has a participant at pid === targetPid, owned by someone != aUid. */
async function ensureHolderAtPid(
  Y: Conversation,
  targetPid: number
): Promise<number> {
  let guard = 0;
  while ((await maxPid(Y.zid)) < targetPid) {
    const { agent } = await initializeParticipant(Y.convId);
    await submitVote(agent, {
      conversation_id: Y.convId,
      tid: Y.matTid,
      vote: MAT_VOTE,
    } as any);
    if (++guard > targetPid + 8) {
      throw new Error(
        `could not materialize a participant at pid ${targetPid}`
      );
    }
  }
  const uidB = await uidOfPid(Y.zid, targetPid);
  if (uidB == null) throw new Error(`no participant at pid ${targetPid} in Y`);
  return uidB;
}

// ---- Tokens issued in conversation X, each carrying X's (uid, pid) ----

/** An anonymous participant token, as the server issues it on the first vote. */
async function anonymousTokenFor(X: Conversation): Promise<ParticipantToken> {
  const { agent } = await initializeParticipant(X.convId);
  const vr = await submitVote(agent, {
    conversation_id: X.convId,
    tid: X.matTid,
    vote: MAT_VOTE,
  } as any);
  const token: string = vr.body?.auth?.token;
  expect(typeof token).toBe("string");
  const claims = decodeJwt(token);
  expect(claims.conversation_id).toBe(X.convId);
  return { token, uid: claims.uid as number, pid: claims.pid as number };
}

/** An XID participant token, as the server issues it. */
async function xidTokenFor(X: Conversation): Promise<ParticipantToken> {
  const xid = `scoped-xid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const init = await initializeParticipantWithXid(X.convId, xid);
  const vr = await submitVote(init.agent, {
    conversation_id: X.convId,
    tid: X.matTid,
    vote: MAT_VOTE,
    xid,
  } as any);
  const token: string = vr.body?.auth?.token || init.token;
  expect(typeof token).toBe("string");
  const claims = decodeJwt(token);
  expect(claims.conversation_id).toBe(X.convId);
  expect(claims.xid_participant).toBe(true);
  return { token, uid: claims.uid as number, pid: claims.pid as number };
}

/**
 * A standard-user participant token. The server mints it with
 * issueStandardUserJWT(sub, conversationId, uid, pid); the real (uid, pid) come
 * from an OIDC user who participated in X, and the token is minted exactly as
 * the server would. The oidc_sub string plays no part in pid resolution.
 */
async function standardUserTokenFor(
  X: Conversation,
  poolIndex: number
): Promise<ParticipantToken> {
  const pu = getPooledTestUser(poolIndex);
  const { agent: oidcAgent } = await getJwtAuthenticatedAgent({
    email: pu.email,
    hname: pu.name,
    password: pu.password,
  } as any);
  await oidcAgent.get("/api/v3/users");
  await submitVote(oidcAgent, {
    conversation_id: X.convId,
    tid: X.matTid,
    vote: MAT_VOTE,
  } as any);
  const uid = (await oidcAgent.get("/api/v3/users")).body?.uid as number;
  const pid = await pidOfUid(X.zid, uid);
  expect(typeof uid).toBe("number");
  expect(typeof pid).toBe("number");
  const token = issueStandardUserJWT(
    `scoped-sub-${Date.now()}`,
    X.convId,
    uid,
    pid as number
  );
  return { token, uid, pid: pid as number };
}

// ---- Shared assertions ----

/** A token for X, used in X: the vote is recorded for its own participant and nothing else changes. */
async function assertVotesAsItself(
  kind: string,
  A: ParticipantToken,
  X: Conversation
) {
  const participantsBefore = await maxPid(X.zid);
  const caller = await agentWithToken(A.token);
  const vr = await submitVote(caller, {
    conversation_id: X.convId,
    tid: X.voteTid,
    vote: VOTE_UNDER_TEST,
  } as any);
  const latest = await latestVotesWithOwner(X.zid, X.voteTid);
  // eslint-disable-next-line no-console
  console.log(
    `[SAME/${kind}] POST /votes -> status ${vr.status}; A=(uid ${A.uid}, pid ${A.pid}); ` +
      `latest votes on tid=${JSON.stringify(latest)}; auth in response=${!!vr
        .body?.auth}`
  );
  expect(vr.status).toBe(200);
  expect(vr.body.currentPid).toBe(A.pid);
  expect(latest).toHaveLength(1);
  expect(latest[0]).toMatchObject({ pid: A.pid, uid: A.uid });
  // No participant was created and no token was reissued: today's path.
  expect(await maxPid(X.zid)).toBe(participantsBefore);
  expect(vr.body.auth).toBeUndefined();
}

/**
 * A token for X, used in Y where someone else (uidB) holds pid A.pid: the vote
 * is recorded for a participant created for the caller in Y. `keepsIdentity`
 * says whether that participant belongs to the token's uid (XID and
 * standard-user tokens keep their user; an anonymous token starts over).
 */
async function assertVotesAsOwnNewParticipant(opts: {
  kind: string;
  A: ParticipantToken;
  Y: Conversation;
  uidB: number;
  keepsIdentity: boolean;
}) {
  const { kind, A, Y, uidB, keepsIdentity } = opts;
  expect(uidB).not.toBe(A.uid);
  expect(await pidOfUid(Y.zid, A.uid)).toBeNull();
  const participantsBefore = await maxPid(Y.zid);

  const caller = await agentWithToken(A.token);
  const vr = await submitVote(caller, {
    conversation_id: Y.convId,
    tid: Y.voteTid,
    vote: VOTE_UNDER_TEST,
  } as any);

  const latest = await latestVotesWithOwner(Y.zid, Y.voteTid);
  const underTokenPid = await rawVoteRows(Y.zid, A.pid, Y.voteTid);
  const ownPidInY = await pidOfUid(Y.zid, A.uid);
  // eslint-disable-next-line no-console
  console.log(
    `[CROSS/${kind}] POST /votes -> status ${vr.status}; ` +
      `A=(uid ${A.uid}, pid ${A.pid} in X); B=(uid ${uidB}, pid ${A.pid} in Y); ` +
      `A's own pid in Y=${ownPidInY}; latest votes on tid=${JSON.stringify(
        latest
      )}; ` +
      `raw votes at (Y, pid ${A.pid}, tid)=${underTokenPid.length}; ` +
      `currentPid=${vr.body?.currentPid}; auth in response=${!!vr.body?.auth}`
  );

  expect(vr.status).toBe(200);
  expect(latest).toHaveLength(1);
  const mine = latest[0];
  // Not the holder of that pid number in Y.
  expect(mine.uid).not.toBe(uidB);
  expect(mine.pid).not.toBe(A.pid);
  expect(underTokenPid).toHaveLength(0);
  // Not an orphan: a participant row owns the vote, and it was created for this vote.
  expect(mine.uid).not.toBeNull();
  expect(mine.pid).toBeGreaterThan(participantsBefore);
  expect(vr.body.currentPid).toBe(mine.pid);
  if (keepsIdentity) {
    expect(mine.uid).toBe(A.uid);
    expect(ownPidInY).toBe(mine.pid);
  }
  // The response carries a token for Y bound to the new participant.
  const token = vr.body?.auth?.token;
  expect(typeof token).toBe("string");
  const claims = decodeJwt(token);
  expect(claims.conversation_id).toBe(Y.convId);
  expect(claims.pid).toBe(mine.pid);
}

describe("participant tokens are scoped to the conversation they were issued in", () => {
  let owner: { agent: any; uid: number };

  beforeAll(async () => {
    owner = await makeOwner(1);
  });

  afterAll(async () => {
    await closePool();
  });

  describe("a token used in its own conversation votes as itself", () => {
    test("anonymous participant token", async () => {
      const X = await makeConversation(owner.agent);
      const A = await anonymousTokenFor(X);
      await assertVotesAsItself("anonymous", A, X);
    });

    test("XID participant token", async () => {
      const X = await makeConversation(owner.agent);
      const A = await xidTokenFor(X);
      await assertVotesAsItself("xid", A, X);
    });

    test("standard-user participant token", async () => {
      const X = await makeConversation(owner.agent);
      const A = await standardUserTokenFor(X, 3);
      await assertVotesAsItself("standard-user", A, X);
    });
  });

  describe("a token used in another conversation votes as a new participant there", () => {
    test("anonymous participant token: not the holder of the same pid, not an orphan", async () => {
      const X = await makeConversation(owner.agent);
      const A = await anonymousTokenFor(X);
      const Y = await makeConversation(owner.agent);
      const uidB = await ensureHolderAtPid(Y, A.pid);
      await assertVotesAsOwnNewParticipant({
        kind: "anonymous",
        A,
        Y,
        uidB,
        keepsIdentity: false,
      });
    });

    test("XID participant token: not the holder of the same pid, not an orphan", async () => {
      const X = await makeConversation(owner.agent);
      const A = await xidTokenFor(X);
      const Y = await makeConversation(owner.agent);
      const uidB = await ensureHolderAtPid(Y, A.pid);
      await assertVotesAsOwnNewParticipant({
        kind: "xid",
        A,
        Y,
        uidB,
        keepsIdentity: true,
      });
    });

    test("standard-user participant token: not the holder of the same pid, not an orphan", async () => {
      const X = await makeConversation(owner.agent);
      const A = await standardUserTokenFor(X, 2);
      const Y = await makeConversation(owner.agent);
      const uidB = await ensureHolderAtPid(Y, A.pid);
      await assertVotesAsOwnNewParticipant({
        kind: "standard-user",
        A,
        Y,
        uidB,
        keepsIdentity: true,
      });
    });

    test("a pid with no participant in Y is never written: the vote gets a participant of its own", async () => {
      const Y = await makeConversation(owner.agent);
      const absentPid = 900000 + Math.floor(Math.random() * 90000);
      // An anonymous token for some other conversation (a throwaway id, so the
      // mismatch path is exercised) carrying a real uid and a pid that exists
      // nowhere in Y.
      const token = issueAnonymousJWT(
        "not-a-real-conv-id",
        owner.uid,
        absentPid
      );
      const participantsBefore = await maxPid(Y.zid);
      const caller = await agentWithToken(token);
      const vr = await submitVote(caller, {
        conversation_id: Y.convId,
        tid: Y.voteTid,
        vote: VOTE_UNDER_TEST,
      } as any);

      const atAbsentPid = await rawVoteRows(Y.zid, absentPid, Y.voteTid);
      const latest = await latestVotesWithOwner(Y.zid, Y.voteTid);
      // eslint-disable-next-line no-console
      console.log(
        `[CROSS/absent-pid] POST /votes -> status ${vr.status}; token pid=${absentPid}; ` +
          `vote rows at (Y, token pid, tid)=${atAbsentPid.length}; ` +
          `latest votes on tid=${JSON.stringify(latest)}`
      );
      expect(vr.status).toBe(200);
      expect(atAbsentPid).toHaveLength(0);
      expect(latest).toHaveLength(1);
      expect(latest[0].uid).not.toBeNull();
      expect(latest[0].pid).toBeGreaterThan(participantsBefore);
      expect(vr.body.currentPid).toBe(latest[0].pid);
      expect(decodeJwt(vr.body.auth.token).conversation_id).toBe(Y.convId);
    });

    test("participationInit with a token for another conversation shows nobody else's votes", async () => {
      const X = await makeConversation(owner.agent);
      const A = await anonymousTokenFor(X);
      const Y = await makeConversation(owner.agent);
      // The holder of pid A.pid in Y has a vote on Y.matTid.
      const uidB = await ensureHolderAtPid(Y, A.pid);
      expect(uidB).not.toBe(A.uid);

      const caller = await agentWithToken(A.token);
      const ir = await caller.get(
        `/api/v3/participationInit?conversation_id=${Y.convId}&pid=-1&lang=en`
      );
      // eslint-disable-next-line no-console
      console.log(
        `[INIT/anonymous] GET /participationInit -> status ${ir.status}; ` +
          `votes=${JSON.stringify(ir.body?.votes)}`
      );
      expect(ir.status).toBe(200);
      expect(ir.body.votes ?? []).toHaveLength(0);
    });
  });

  describe("controls", () => {
    test("raw OIDC access token (carries no pid): votes as the caller's own participant in Y", async () => {
      const X = await makeConversation(owner.agent);
      const pu = getPooledTestUser(3);
      const { agent: oidcAgent } = await getJwtAuthenticatedAgent({
        email: pu.email,
        hname: pu.name,
        password: pu.password,
      } as any);
      await oidcAgent.get("/api/v3/users");
      await submitVote(oidcAgent, {
        conversation_id: X.convId,
        tid: X.matTid,
        vote: MAT_VOTE,
      } as any);
      const uidA = (await oidcAgent.get("/api/v3/users")).body?.uid as number;
      const pidAInX = await pidOfUid(X.zid, uidA);

      const Y = await makeConversation(owner.agent);
      const uidB = await ensureHolderAtPid(Y, pidAInX as number);
      expect(uidB).not.toBe(uidA);

      const vr = await submitVote(oidcAgent, {
        conversation_id: Y.convId,
        tid: Y.voteTid,
        vote: VOTE_UNDER_TEST,
      } as any);

      const latest = await latestVotesWithOwner(Y.zid, Y.voteTid);
      const aPidInY = await pidOfUid(Y.zid, uidA);
      // eslint-disable-next-line no-console
      console.log(
        `[CONTROL/oidc] POST /votes -> status ${vr.status}; A uid=${uidA} (pid in X=${pidAInX}); ` +
          `A's own pid in Y=${aPidInY}; B uid=${uidB} at pid ${pidAInX}; ` +
          `latest=${JSON.stringify(latest)}`
      );
      expect(vr.status).toBe(200);
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ uid: uidA, pid: aPidInY });
    });

    test("comment route with an anonymous token for another conversation: attributed to the caller", async () => {
      const X = await makeConversation(owner.agent);
      const A = await anonymousTokenFor(X);
      const Y = await makeConversation(owner.agent);
      const uidB = await ensureHolderAtPid(Y, A.pid);

      const caller = await agentWithToken(A.token);
      const txt = `anon cross-conv comment ${Date.now()}`;
      const cr = await submitComment(caller, {
        conversation_id: Y.convId,
        txt,
      } as any);
      const { rows } = await pool.query(
        "SELECT pid, uid FROM comments WHERE zid = $1 AND txt = $2",
        [Y.zid, txt]
      );
      // eslint-disable-next-line no-console
      console.log(
        `[CONTROL/comment anonymous] POST /comments -> status ${
          cr.status
        }; stored=${JSON.stringify(rows)}; A uid=${
          A.uid
        }, B uid=${uidB}, token pid=${A.pid}`
      );
      expect(cr.status).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0].uid).not.toBe(uidB);
      expect(await uidOfPid(Y.zid, rows[0].pid)).toBe(rows[0].uid);
    });

    test("comment route with an XID token for another conversation: attributed to the caller", async () => {
      const X = await makeConversation(owner.agent);
      const A = await xidTokenFor(X);
      const Y = await makeConversation(owner.agent);
      const uidB = await ensureHolderAtPid(Y, A.pid);

      const caller = await agentWithToken(A.token);
      const txt = `xid cross-conv comment ${Date.now()}`;
      const cr = await submitComment(caller, {
        conversation_id: Y.convId,
        txt,
      } as any);
      const { rows } = await pool.query(
        "SELECT pid, uid FROM comments WHERE zid = $1 AND txt = $2",
        [Y.zid, txt]
      );
      // eslint-disable-next-line no-console
      console.log(
        `[CONTROL/comment xid] POST /comments -> status ${
          cr.status
        }; stored=${JSON.stringify(rows)}; A uid=${
          A.uid
        }, B uid=${uidB}, token pid=${A.pid}`
      );
      expect(cr.status).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0].uid).toBe(A.uid);
      expect(rows[0].uid).not.toBe(uidB);
    });
  });
});
