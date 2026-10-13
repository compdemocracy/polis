import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  newAgent,
  createConversation,
  createComment,
  initializeParticipant,
  initializeParticipantWithXid,
  submitVote,
  submitComment,
  updateConversation,
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
 * ensureParticipant (server/src/auth/ensure-participant.ts) decides whether the
 * token is for another conversation against the conversation the route
 * resolved (POST /votes reads conversation_id from the body; a conversation_id
 * in the query string is not where the vote goes), reads the request's uid/pid
 * only after the conversation-mismatch handler has run, and never lets a token
 * for another conversation supply this conversation's pid. A token used in the
 * conversation it was issued in takes exactly the path it always has.
 *
 * Cases:
 *   - same-conversation token (anonymous, XID, standard-user): votes as itself,
 *     creates no participant, is issued no new token; also with a stray
 *     conversation_id for another conversation in the query string;
 *   - cross-conversation token (anonymous, XID, standard-user): votes as a new
 *     participant in Y, not as the holder of the same pid in Y, not as an
 *     orphan pid, and the response carries a token for Y; presenting the same
 *     token again votes under that same participant and again gets Y's token;
 *   - the same with the token's own conversation_id in the query string and Y
 *     in the body, with the pid held by someone in Y and with it absent;
 *   - cross-conversation token whose pid has no participant in Y: no orphan row;
 *   - a conversation that requires an invite: an existing participant's
 *     cross-conversation token votes under its existing participant, a new
 *     participant without an invite is refused and nothing is written, and the
 *     owner's cross-conversation token votes as the owner;
 *   - participationInit with a cross-conversation token shows nobody else's votes;
 *   - controls: the raw OIDC access token (carries no pid) and the comment route
 *     (re-resolves the pid by (zid, uid)) attribute to the caller.
 *
 * Votes are written only through the real vote route; nothing here writes a
 * vote value directly. Each test logs the stored rows for the record.
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

/**
 * POST /api/v3/votes with the conversation_id in the body, and optionally a
 * (different) conversation_id in the query string. The route reads the body.
 */
async function postVote(
  agent: any,
  body: { conversation_id: string; tid: number; vote: number },
  queryConversationId?: string
) {
  const path =
    queryConversationId === undefined
      ? "/api/v3/votes"
      : `/api/v3/votes?conversation_id=${encodeURIComponent(
          queryConversationId
        )}`;
  const response = await agent.post(path).send(body);
  let parsed: any;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    parsed = response.text;
  }
  return { status: response.status as number, body: parsed };
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
async function makeConversation(
  ownerAgent: any,
  extra: Record<string, unknown> = {}
): Promise<Conversation> {
  const convId = await createConversation(ownerAgent, {
    is_active: true,
    is_anon: true,
    strict_moderation: false,
    profanity_filter: false,
    ...extra,
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

/** The OIDC agent of a pooled user, with its uid. */
async function oidcUser(
  poolIndex: number
): Promise<{ agent: any; uid: number }> {
  const pu = getPooledTestUser(poolIndex);
  const { agent } = await getJwtAuthenticatedAgent({
    email: pu.email,
    hname: pu.name,
    password: pu.password,
  } as any);
  const uid = (await agent.get("/api/v3/users")).body?.uid as number;
  expect(typeof uid).toBe("number");
  return { agent, uid };
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
  const { agent: oidcAgent, uid } = await oidcUser(poolIndex);
  await submitVote(oidcAgent, {
    conversation_id: X.convId,
    tid: X.matTid,
    vote: MAT_VOTE,
  } as any);
  const pid = await pidOfUid(X.zid, uid);
  expect(typeof pid).toBe("number");
  const token = issueStandardUserJWT(
    `scoped-sub-${Date.now()}`,
    X.convId,
    uid,
    pid as number
  );
  return { token, uid, pid: pid as number };
}

type TokenKind = "anonymous" | "xid" | "standard-user";

/** A token of the given kind issued in X. Pooled users 2 and 3 are the standard users. */
async function tokenFor(
  kind: TokenKind,
  X: Conversation,
  poolIndex = 2
): Promise<ParticipantToken> {
  if (kind === "anonymous") return anonymousTokenFor(X);
  if (kind === "xid") return xidTokenFor(X);
  return standardUserTokenFor(X, poolIndex);
}

/** XID and standard-user tokens keep their user in another conversation; an anonymous token starts over. */
function keepsIdentity(kind: TokenKind): boolean {
  return kind !== "anonymous";
}

// ---- Shared assertions ----

/**
 * A token for X, used in X: the vote is recorded for its own participant and
 * nothing else changes. `queryConversationId` puts a conversation_id in the
 * query string as well; the body's is the one the route reads.
 */
async function assertVotesAsItself(
  kind: string,
  A: ParticipantToken,
  X: Conversation,
  queryConversationId?: string
) {
  const participantsBefore = await maxPid(X.zid);
  const caller = await agentWithToken(A.token);
  const vr = await postVote(
    caller,
    { conversation_id: X.convId, tid: X.voteTid, vote: VOTE_UNDER_TEST },
    queryConversationId
  );
  const latest = await latestVotesWithOwner(X.zid, X.voteTid);
  // eslint-disable-next-line no-console
  console.log(
    `[SAME/${kind}] POST /votes${
      queryConversationId ? " (query conversation_id differs)" : ""
    } -> status ${vr.status}; A=(uid ${A.uid}, pid ${A.pid}); ` +
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
 * A token for X, used in Y: the vote is recorded for a participant created
 * for the caller in Y. `holder` is the uid of whoever holds pid A.pid in Y,
 * or null when nobody does. `queryConversationId` puts a conversation_id in
 * the query string as well (the body names Y). For the kinds that keep their
 * user, the same token is then presented again: the vote goes to that same
 * participant and the response again carries Y's token.
 */
async function assertVotesAsOwnNewParticipant(opts: {
  kind: TokenKind;
  A: ParticipantToken;
  Y: Conversation;
  holder: number | null;
  queryConversationId?: string;
}) {
  const { kind, A, Y, holder, queryConversationId } = opts;
  expect(holder).not.toBe(A.uid);
  expect(await uidOfPid(Y.zid, A.pid)).toBe(holder);
  expect(await pidOfUid(Y.zid, A.uid)).toBeNull();
  const participantsBefore = await maxPid(Y.zid);

  const caller = await agentWithToken(A.token);
  const vr = await postVote(
    caller,
    { conversation_id: Y.convId, tid: Y.voteTid, vote: VOTE_UNDER_TEST },
    queryConversationId
  );

  const latest = await latestVotesWithOwner(Y.zid, Y.voteTid);
  const underTokenPid = await rawVoteRows(Y.zid, A.pid, Y.voteTid);
  const ownPidInY = await pidOfUid(Y.zid, A.uid);
  // eslint-disable-next-line no-console
  console.log(
    `[CROSS/${kind}] POST /votes${
      queryConversationId ? " (query conversation_id = X)" : ""
    } -> status ${vr.status}; ` +
      `A=(uid ${A.uid}, pid ${A.pid} in X); holder of pid ${A.pid} in Y=${holder}; ` +
      `A's own pid in Y=${ownPidInY}; latest votes on tid=${JSON.stringify(
        latest
      )}; ` +
      `raw votes at (Y, pid ${A.pid}, tid)=${underTokenPid.length}; ` +
      `currentPid=${vr.body?.currentPid}; auth in response=${!!vr.body?.auth}`
  );

  expect(vr.status).toBe(200);
  expect(latest).toHaveLength(1);
  const mine = latest[0];
  if (holder !== null) {
    // Not the holder of that pid number in Y, and nothing under that pid.
    expect(mine.uid).not.toBe(holder);
    expect(mine.pid).not.toBe(A.pid);
    expect(underTokenPid).toHaveLength(0);
    expect(await uidOfPid(Y.zid, A.pid)).toBe(holder);
  }
  // Not an orphan: a participant row owns the vote, and it was created for
  // this vote. (When nobody held the token's pid number in Y, the participant
  // created here may well be allocated that same number; the number is not
  // what matters, the row is.)
  expect(mine.uid).not.toBeNull();
  expect(await uidOfPid(Y.zid, mine.pid)).toBe(mine.uid);
  expect(mine.pid).toBeGreaterThan(participantsBefore);
  expect(vr.body.currentPid).toBe(mine.pid);
  if (keepsIdentity(kind)) {
    expect(mine.uid).toBe(A.uid);
    expect(ownPidInY).toBe(mine.pid);
  }
  // The response carries a token for Y bound to the new participant.
  const token = vr.body?.auth?.token;
  expect(typeof token).toBe("string");
  const claims = decodeJwt(token);
  expect(claims.conversation_id).toBe(Y.convId);
  expect(claims.pid).toBe(mine.pid);

  if (keepsIdentity(kind)) {
    // The same token for X, presented again in Y: the existing participant,
    // no new row, and again a token for Y.
    const participantsAfter = await maxPid(Y.zid);
    const again = await postVote(
      await agentWithToken(A.token),
      { conversation_id: Y.convId, tid: Y.voteTid, vote: VOTE_UNDER_TEST },
      queryConversationId
    );
    const latestAgain = await latestVotesWithOwner(Y.zid, Y.voteTid);
    // eslint-disable-next-line no-console
    console.log(
      `[CROSS/${kind}] second POST /votes with the same token -> status ${again.status}; ` +
        `currentPid=${again.body?.currentPid}; latest=${JSON.stringify(
          latestAgain
        )}; auth in response=${!!again.body?.auth}`
    );
    expect(again.status).toBe(200);
    expect(again.body.currentPid).toBe(mine.pid);
    expect(latestAgain).toHaveLength(1);
    expect(latestAgain[0]).toMatchObject({ pid: mine.pid, uid: A.uid });
    expect(await maxPid(Y.zid)).toBe(participantsAfter);
    const againClaims = decodeJwt(again.body?.auth?.token);
    expect(againClaims.conversation_id).toBe(Y.convId);
    expect(againClaims.pid).toBe(mine.pid);
  }
}

const KINDS: TokenKind[] = ["anonymous", "xid", "standard-user"];

describe("participant tokens are scoped to the conversation they were issued in", () => {
  let owner: { agent: any; uid: number };

  beforeAll(async () => {
    owner = await makeOwner(1);
  });

  afterAll(async () => {
    await closePool();
  });

  describe("a token used in its own conversation votes as itself", () => {
    for (const kind of KINDS) {
      test(`${kind} participant token`, async () => {
        const X = await makeConversation(owner.agent);
        const A = await tokenFor(kind, X, 3);
        await assertVotesAsItself(kind, A, X);
      });

      test(`${kind} participant token, with another conversation's id in the query string`, async () => {
        const X = await makeConversation(owner.agent);
        const A = await tokenFor(kind, X, 3);
        const Y = await makeConversation(owner.agent);
        await assertVotesAsItself(kind, A, X, Y.convId);
      });
    }
  });

  describe("a token used in another conversation votes as a new participant there", () => {
    for (const kind of KINDS) {
      test(`${kind} participant token: not the holder of the same pid, not an orphan`, async () => {
        const X = await makeConversation(owner.agent);
        const A = await tokenFor(kind, X);
        const Y = await makeConversation(owner.agent);
        const holder = await ensureHolderAtPid(Y, A.pid);
        await assertVotesAsOwnNewParticipant({ kind, A, Y, holder });
      });
    }

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

  describe("the conversation the route resolves decides the token's scope", () => {
    // POST /votes reads conversation_id from the body. A conversation_id in
    // the query string, even the token's own, does not change where the vote
    // is recorded, so it must not change whose vote it is either.
    for (const kind of KINDS) {
      test(`${kind} token for X, query conversation_id = X, body conversation_id = Y: the pid is held by someone in Y`, async () => {
        const X = await makeConversation(owner.agent);
        const A = await tokenFor(kind, X);
        const Y = await makeConversation(owner.agent);
        const holder = await ensureHolderAtPid(Y, A.pid);
        await assertVotesAsOwnNewParticipant({
          kind,
          A,
          Y,
          holder,
          queryConversationId: X.convId,
        });
      });

      test(`${kind} token for X, query conversation_id = X, body conversation_id = Y: the pid is absent in Y`, async () => {
        const X = await makeConversation(owner.agent);
        const A = await tokenFor(kind, X);
        const Y = await makeConversation(owner.agent);
        expect(await uidOfPid(Y.zid, A.pid)).toBeNull();
        await assertVotesAsOwnNewParticipant({
          kind,
          A,
          Y,
          holder: null,
          queryConversationId: X.convId,
        });
      });
    }
  });

  describe("a conversation that requires an invite", () => {
    test("an existing participant's token for another conversation votes under its existing participant", async () => {
      const X = await makeConversation(owner.agent);
      const Y = await makeConversation(owner.agent);
      // U joins Y while it is open, then Y starts requiring an invite.
      const U = await oidcUser(3);
      await submitVote(U.agent, {
        conversation_id: Y.convId,
        tid: Y.matTid,
        vote: MAT_VOTE,
      } as any);
      const pidInY = await pidOfUid(Y.zid, U.uid);
      expect(typeof pidInY).toBe("number");
      const ur = await updateConversation(owner.agent, {
        conversation_id: Y.convId,
        treevite_enabled: true,
      });
      expect(ur.status).toBe(200);
      const A = await standardUserTokenFor(X, 3);
      expect(A.uid).toBe(U.uid);
      const participantsBefore = await maxPid(Y.zid);

      const vr = await postVote(await agentWithToken(A.token), {
        conversation_id: Y.convId,
        tid: Y.voteTid,
        vote: VOTE_UNDER_TEST,
      });
      const latest = await latestVotesWithOwner(Y.zid, Y.voteTid);
      // eslint-disable-next-line no-console
      console.log(
        `[INVITE/existing] POST /votes -> status ${vr.status}; U=(uid ${U.uid}, pid ${pidInY} in Y, pid ${A.pid} in X); ` +
          `latest=${JSON.stringify(latest)}; auth in response=${!!vr.body
            ?.auth}`
      );
      expect(vr.status).toBe(200);
      expect(vr.body.currentPid).toBe(pidInY);
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ pid: pidInY, uid: U.uid });
      expect(await maxPid(Y.zid)).toBe(participantsBefore);
      const claims = decodeJwt(vr.body?.auth?.token);
      expect(claims.conversation_id).toBe(Y.convId);
      expect(claims.pid).toBe(pidInY);
    });

    test("a token for another conversation held by someone without an invite is refused, and nothing is written", async () => {
      const X = await makeConversation(owner.agent);
      const Y = await makeConversation(owner.agent, { treevite_enabled: true });
      const participantsBefore = await maxPid(Y.zid);
      for (const kind of ["anonymous", "standard-user"] as TokenKind[]) {
        const A = await tokenFor(kind, X, 2);
        expect(await pidOfUid(Y.zid, A.uid)).toBeNull();
        const vr = await postVote(await agentWithToken(A.token), {
          conversation_id: Y.convId,
          tid: Y.voteTid,
          vote: VOTE_UNDER_TEST,
        });
        // eslint-disable-next-line no-console
        console.log(
          `[INVITE/new ${kind}] POST /votes -> status ${
            vr.status
          }; body=${JSON.stringify(vr.body)}`
        );
        expect(vr.status).toBe(401);
        expect(vr.body?.error).toBe("polis_err_treevite_auth_required");
        expect(await latestVotesWithOwner(Y.zid, Y.voteTid)).toHaveLength(0);
        expect(await rawVoteRows(Y.zid, A.pid, Y.voteTid)).toHaveLength(0);
        expect(await maxPid(Y.zid)).toBe(participantsBefore);
      }
    });

    test("the owner's token for another conversation votes as the owner", async () => {
      const X = await makeConversation(owner.agent);
      const Y = await makeConversation(owner.agent, { treevite_enabled: true });
      const ownerPidInY = await pidOfUid(Y.zid, owner.uid);
      expect(typeof ownerPidInY).toBe("number");
      const A = await standardUserTokenFor(X, 1);
      expect(A.uid).toBe(owner.uid);
      const participantsBefore = await maxPid(Y.zid);

      const vr = await postVote(await agentWithToken(A.token), {
        conversation_id: Y.convId,
        tid: Y.voteTid,
        vote: VOTE_UNDER_TEST,
      });
      const latest = await latestVotesWithOwner(Y.zid, Y.voteTid);
      // eslint-disable-next-line no-console
      console.log(
        `[INVITE/owner] POST /votes -> status ${vr.status}; owner=(uid ${owner.uid}, pid ${ownerPidInY} in Y); ` +
          `latest=${JSON.stringify(latest)}`
      );
      expect(vr.status).toBe(200);
      expect(vr.body.currentPid).toBe(ownerPidInY);
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ pid: ownerPidInY, uid: owner.uid });
      expect(await maxPid(Y.zid)).toBe(participantsBefore);
    });
  });

  describe("controls", () => {
    test("raw OIDC access token (carries no pid): votes as the caller's own participant in Y", async () => {
      const X = await makeConversation(owner.agent);
      const { agent: oidcAgent, uid: uidA } = await oidcUser(3);
      await submitVote(oidcAgent, {
        conversation_id: X.convId,
        tid: X.matTid,
        vote: MAT_VOTE,
      } as any);
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
