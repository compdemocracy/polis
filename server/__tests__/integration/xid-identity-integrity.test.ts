/**
 * XID identity integrity on the participation path.
 *
 * An external id (xid) names a participant on behalf of an integrating site.
 * These tests pin three rules of identity resolution in ensureParticipant:
 *
 * 1. A request's xid names the identity. When it differs from the xid bound
 *    to the participant token presented with it, the token's participant is
 *    never used: the named xid is resolved on its own, through the
 *    conversation's xid gates, and the response carries a token for it.
 * 2. The conversation's allow-list applies whenever an xid participates: on
 *    the first join and on every vote, comment and read after it, and only
 *    this conversation's list counts. An xid removed from the list is refused
 *    from then on; an xid admitted in another conversation of the same owner
 *    is not admitted here on that account.
 * 3. An XID token issued for another conversation never carries its uid or
 *    pid into this one; its xid is resolved under this conversation's owner
 *    like a first contact, gates included.
 *
 * And the legitimate paths that must keep working: anonymous participants,
 * xid participants with their own token, a fresh allow-listed xid, invited
 * participants, the owner and a site moderator.
 *
 * Votes are only ever sent through the API, with the wire value taken from the
 * server's vote convention module.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  generateRandomXid,
  getJwtAuthenticatedAgent,
  initializeParticipantWithXid,
  newAgent,
  submitComment,
  submitVote,
  updateConversation,
} from "../setup/api-test-helpers";
import {
  getPooledTestUser,
  RESERVED_POOLED_USER_INDEXES,
} from "../setup/test-user-helpers";
import { WIRE_AGREE } from "../../src/votes/convention";

interface Claims {
  conversation_id?: string;
  uid?: number;
  pid?: number;
  xid?: string;
  anonymous_participant?: boolean;
  xid_participant?: boolean;
}

function decode(token: string): Claims {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  return JSON.parse(Buffer.from(parts[1], "base64url").toString());
}

function pooled(index: number) {
  const u = getPooledTestUser(index);
  return { email: u.email, hname: u.name, password: u.password };
}

const XID_NOT_ALLOWED = "polis_err_xid_not_allowed";

describe("xid identity integrity", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let ownerA: Agent;
  let ownerB: Agent;
  let moderator: Agent;
  let ownerAUid: number;

  // Owner A's conversations: codes, zids and a seed statement each.
  let open: string;
  let openZid: number;
  let openTids: number[];
  let allow: string; // use_xid_whitelist; list: listedA, crossOwnerXid
  let allowZid: number;
  let allowTid: number;
  let allowOther: string; // use_xid_whitelist; list: listedOther
  let allowOtherZid: number;
  let allowOtherTid: number;
  let allowRevoke: string; // use_xid_whitelist; list: revokeA, revokeB
  let allowRevokeZid: number;
  let allowRevokeTids: number[];
  let xidReq: string; // xid_required
  let xidReqZid: number;
  let xidReqTid: number;
  let tree: string; // treevite_enabled, one wave of owner invites
  let treeTid: number;

  // Owner B's conversation.
  let openB: string;

  const listedA = `listed-a-${Date.now()}`;
  const listedOther = `listed-other-${Date.now()}`;
  const revokeA = `revoke-a-${Date.now()}`;
  const revokeB = `revoke-b-${Date.now()}`;
  const crossOwnerXid = `cross-owner-${Date.now()}`;

  const zidOf = async (code: string): Promise<number> =>
    (await pool.query("select zid from zinvites where zinvite = $1", [code]))
      .rows[0].zid;

  const participantRows = async (zid: number, uid: number) =>
    (
      await pool.query(
        "select pid, uid from participants where zid = $1 and uid = $2",
        [zid, uid]
      )
    ).rows;

  const participantCount = async (zid: number): Promise<number> =>
    (
      await pool.query(
        "select count(*)::int as n from participants where zid = $1",
        [zid]
      )
    ).rows[0].n;

  const xidRows = async (owner: number, xid: string) =>
    (
      await pool.query(
        "select uid, zid, pid from xids where owner = $1 and xid = $2",
        [owner, xid]
      )
    ).rows;

  const voteRowCount = async (
    zid: number,
    pid: number,
    tid: number
  ): Promise<number> =>
    (
      await pool.query(
        "select count(*)::int as n from votes where zid = $1 and pid = $2 and tid = $3",
        [zid, pid, tid]
      )
    ).rows[0].n;

  /** Every xid owner A has listed, from any conversation or owner-wide. */
  const ownerList = async (): Promise<string[]> =>
    (
      await pool.query(
        "select xid from xid_whitelist where owner = $1 order by xid",
        [ownerAUid]
      )
    ).rows.map((r: { xid: string }) => r.xid);

  const ownerListed = async (xid: string): Promise<boolean> =>
    (
      await pool.query(
        "select 1 from xid_whitelist where owner = $1 and xid = $2",
        [ownerAUid, xid]
      )
    ).rows.length > 0;

  const seed = async (
    agent: Agent,
    code: string,
    txt: string
  ): Promise<number> => {
    const r = await agent
      .post("/api/v3/comments")
      .send({ conversation_id: code, txt, is_seed: true });
    expect(r.status).toBe(200);
    expect(typeof r.body.tid).toBe("number");
    return r.body.tid;
  };

  const agentWithToken = async (token: string): Promise<Agent> => {
    const a = await newAgent();
    a.set("Authorization", `Bearer ${token}`);
    return a;
  };

  /** POST /votes as `agent` (a fresh, credential-less agent when null). */
  const agree = (
    agent: Agent | null,
    code: string,
    tid: number,
    xid?: string
  ) =>
    submitVote(agent, {
      conversation_id: code,
      tid,
      vote: WIRE_AGREE,
      ...(xid !== undefined && { xid }),
    });

  const comment = (agent: Agent | null, code: string, xid?: string) =>
    submitComment(agent, {
      conversation_id: code,
      txt: `statement ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      ...(xid !== undefined && { xid }),
    });

  const nextStatement = (agent: Agent, code: string) =>
    agent.get(`/api/v3/nextComment?conversation_id=${code}`);

  /** A participant of `code` under `xid`, with the XID token the server issued. */
  const joinWithXid = async (code: string, xid: string) => {
    const r = await initializeParticipantWithXid(code, xid);
    expect(r.status).toBe(200);
    expect(typeof r.token).toBe("string");
    const claims = decode(r.token as string);
    expect(claims.xid).toBe(xid);
    expect(claims.conversation_id).toBe(code);
    return { agent: r.agent, token: r.token as string, claims };
  };

  const setAllowList = async (
    code: string,
    xids: string[],
    replace_all = false
  ) => {
    const r = await ownerA.post("/api/v3/xidAllowList").send({
      conversation_id: code,
      xid_allow_list: xids,
      ...(replace_all && { replace_all: true }),
    });
    expect(r.status).toBe(200);
  };

  const makeGated = async (
    topic: string,
    flags: Record<string, boolean>,
    seeds: string[]
  ) => {
    const code = await createConversation(ownerA, { topic });
    const update = await updateConversation(ownerA, {
      conversation_id: code,
      ...flags,
    });
    expect(update.status).toBe(200);
    const tids: number[] = [];
    for (const txt of seeds) {
      tids.push(await seed(ownerA, code, txt));
    }
    return { code, zid: await zidOf(code), tids };
  };

  beforeAll(async () => {
    ({ pool } = await import("../setup/db-test-helpers"));
    ({ agent: ownerA } = await getJwtAuthenticatedAgent(
      pooled(RESERVED_POOLED_USER_INDEXES.xidIdentityOwnerA)
    ));
    ({ agent: ownerB } = await getJwtAuthenticatedAgent(
      pooled(RESERVED_POOLED_USER_INDEXES.xidIdentityOwnerB)
    ));
    const moderatorUser = pooled(
      RESERVED_POOLED_USER_INDEXES.xidIdentityModerator
    );
    ({ agent: moderator } = await getJwtAuthenticatedAgent(moderatorUser));
    // The moderator's user row must exist before its site is aligned.
    expect((await moderator.get("/api/v3/users")).status).toBe(200);

    open = await createConversation(ownerA, { topic: "xid identity: open" });
    openZid = await zidOf(open);
    openTids = [
      await seed(ownerA, open, "open seed 1"),
      await seed(ownerA, open, "open seed 2"),
      await seed(ownerA, open, "open seed 3"),
    ];
    ownerAUid = (
      await pool.query("select owner from conversations where zid = $1", [
        openZid,
      ])
    ).rows[0].owner;

    // A site moderator: a user on the owner's site.
    const ownerRow = await pool.query(
      "select site_id from users where uid = $1",
      [ownerAUid]
    );
    const modRow = await pool.query("select uid from users where email = $1", [
      moderatorUser.email,
    ]);
    await pool.query("update users set site_id = $1 where uid = $2", [
      ownerRow.rows[0].site_id,
      modRow.rows[0].uid,
    ]);

    ({
      code: allow,
      zid: allowZid,
      tids: [allowTid],
    } = await makeGated(
      "xid identity: allow-list",
      { use_xid_whitelist: true },
      ["allow seed"]
    ));
    await setAllowList(allow, [listedA, crossOwnerXid]);

    ({
      code: allowOther,
      zid: allowOtherZid,
      tids: [allowOtherTid],
    } = await makeGated(
      "xid identity: allow-list, other conversation",
      { use_xid_whitelist: true },
      ["allow-other seed"]
    ));
    await setAllowList(allowOther, [listedOther]);

    ({
      code: allowRevoke,
      zid: allowRevokeZid,
      tids: allowRevokeTids,
    } = await makeGated(
      "xid identity: allow-list, revocation",
      { use_xid_whitelist: true },
      ["revoke seed 1", "revoke seed 2", "revoke seed 3"]
    ));
    await setAllowList(allowRevoke, [revokeA, revokeB]);

    ({
      code: xidReq,
      zid: xidReqZid,
      tids: [xidReqTid],
    } = await makeGated("xid identity: xid required", { xid_required: true }, [
      "xid-required seed",
    ]));

    tree = await createConversation(ownerA, {
      topic: "xid identity: invite tree",
      treevite_enabled: true,
    });
    treeTid = await seed(ownerA, tree, "invite-tree seed");
    const wave = await ownerA.post("/api/v3/treevite/waves").send({
      conversation_id: tree,
      owner_invites: 3,
      invites_per_user: 0,
    });
    expect(wave.status).toBe(201);

    openB = await createConversation(ownerB, { topic: "xid identity: B" });
    await seed(ownerB, openB, "owner B seed");

    const flags = await pool.query(
      "select zid, xid_required, use_xid_whitelist from conversations where zid = any($1::int[])",
      [[allowZid, allowOtherZid, allowRevokeZid, xidReqZid]]
    );
    for (const row of flags.rows) {
      if (row.zid === xidReqZid) expect(row.xid_required).toBe(true);
      else expect(row.use_xid_whitelist).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  describe("a request's xid names the identity, never the token's participant", () => {
    test("open conversation: a token bound to xid A with xid B in the request votes as B's own participant; A's vote is untouched; the response carries a token for B", async () => {
      const xidA = generateRandomXid();
      const xidB = generateRandomXid();
      const a = await joinWithXid(open, xidA);

      const asA = await agree(a.agent, open, openTids[0]);
      expect(asA.status).toBe(200);
      const pidA = asA.body.currentPid;
      expect(pidA).toBe(a.claims.pid);
      expect(await voteRowCount(openZid, pidA, openTids[0])).toBe(1);

      // The same token, with another xid in the body.
      const asB = await agree(
        await agentWithToken(a.token),
        open,
        openTids[0],
        xidB
      );
      expect(asB.status).toBe(200);
      expect(asB.body.currentPid).not.toBe(pidA);
      expect(await voteRowCount(openZid, pidA, openTids[0])).toBe(1);

      const rowsB = await xidRows(ownerAUid, xidB);
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].uid).not.toBe(a.claims.uid);
      expect(await participantRows(openZid, rowsB[0].uid)).toEqual([
        { pid: asB.body.currentPid, uid: rowsB[0].uid },
      ]);

      const tokenB = decode(asB.body.auth?.token);
      expect(tokenB.xid).toBe(xidB);
      expect(tokenB.xid_participant).toBe(true);
      expect(tokenB.pid).toBe(asB.body.currentPid);
      expect(tokenB.conversation_id).toBe(open);

      // A's token with A's own xid is still A.
      const again = await agree(
        await agentWithToken(a.token),
        open,
        openTids[1],
        xidA
      );
      expect(again.status).toBe(200);
      expect(again.body.currentPid).toBe(pidA);
    });

    test("allow-listed conversation: a token bound to a listed xid with an unlisted xid in the request is refused, and nothing is written", async () => {
      const listed = await joinWithXid(allow, listedA);
      const unlisted = generateRandomXid();
      const participantsBefore = await participantCount(allowZid);

      const vote = await agree(
        await agentWithToken(listed.token),
        allow,
        allowTid,
        unlisted
      );
      expect(vote.status).toBe(403);
      expect(JSON.stringify(vote.body)).toContain(XID_NOT_ALLOWED);

      const statement = await comment(
        await agentWithToken(listed.token),
        allow,
        unlisted
      );
      expect(statement.status).toBe(403);
      expect(JSON.stringify(statement.body)).toContain(XID_NOT_ALLOWED);

      expect(await xidRows(ownerAUid, unlisted)).toHaveLength(0);
      expect(await participantCount(allowZid)).toBe(participantsBefore);
      // The listed participant did not vote.
      expect(
        await voteRowCount(allowZid, listed.claims.pid as number, allowTid)
      ).toBe(0);
    });

    test("xid_required conversation: a token bound to xid A with xid B in the request is B's own participant", async () => {
      const xidA = generateRandomXid();
      const xidB = generateRandomXid();
      const a = await joinWithXid(xidReq, xidA);

      const asB = await agree(
        await agentWithToken(a.token),
        xidReq,
        xidReqTid,
        xidB
      );
      expect(asB.status).toBe(200);
      expect(asB.body.currentPid).not.toBe(a.claims.pid);
      expect(await xidRows(ownerAUid, xidB)).toHaveLength(1);
      expect(decode(asB.body.auth?.token).xid).toBe(xidB);
      expect(
        await voteRowCount(xidReqZid, a.claims.pid as number, xidReqTid)
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe("the allow-list is the owner's, and applies whenever an xid participates", () => {
    test("an xid known from another conversation of the owner but never listed for the owner is refused on its first join here: bare xid, XID token, vote, comment and participationInit", async () => {
      const known = generateRandomXid();
      const elsewhere = await joinWithXid(open, known);

      const bare = await agree(null, allow, allowTid, known);
      expect(bare.status).toBe(403);
      expect(JSON.stringify(bare.body)).toContain(XID_NOT_ALLOWED);

      const withToken = await agree(
        await agentWithToken(elsewhere.token),
        allow,
        allowTid
      );
      expect(withToken.status).toBe(403);
      expect(JSON.stringify(withToken.body)).toContain(XID_NOT_ALLOWED);

      const statement = await comment(null, allow, known);
      expect(statement.status).toBe(403);
      expect(JSON.stringify(statement.body)).toContain(XID_NOT_ALLOWED);

      const init = await (
        await newAgent()
      ).get(`/api/v3/participationInit?conversation_id=${allow}&xid=${known}`);
      expect(init.status).toBe(403);

      expect(
        await participantRows(allowZid, elsewhere.claims.uid as number)
      ).toHaveLength(0);
    });

    test("removal from the list (replace_all from one conversation) refuses the next vote, comment and next-statement read in every gated conversation of the owner; relisting admits the same participants again", async () => {
      const a = await joinWithXid(allowRevoke, revokeA);
      const first = await agree(a.agent, allowRevoke, allowRevokeTids[0]);
      expect(first.status).toBe(200);
      const pid = first.body.currentPid;
      expect(pid).toBe(a.claims.pid);

      // Listed from allowRevoke, so admitted to the owner's other gated
      // conversation too: the same xid record, a participant there.
      const elsewhere = await agree(
        await agentWithToken(a.token),
        allow,
        allowTid
      );
      expect(elsewhere.status).toBe(200);
      const pidElsewhere = elsewhere.body.currentPid;
      expect(await participantRows(allowZid, a.claims.uid as number)).toEqual([
        { pid: pidElsewhere, uid: a.claims.uid },
      ]);

      // The owner's list without revokeA, posted from allowRevoke.
      const without = (await ownerList()).filter((x) => x !== revokeA);
      await setAllowList(allowRevoke, without, true);
      expect(await ownerListed(revokeA)).toBe(false);
      expect(await ownerListed(revokeB)).toBe(true);
      expect(await ownerListed(listedA)).toBe(true);

      const vote = await agree(
        await agentWithToken(a.token),
        allowRevoke,
        allowRevokeTids[1]
      );
      expect(vote.status).toBe(403);
      expect(JSON.stringify(vote.body)).toContain(XID_NOT_ALLOWED);
      expect(await voteRowCount(allowRevokeZid, pid, allowRevokeTids[1])).toBe(
        0
      );

      const statement = await comment(
        await agentWithToken(a.token),
        allowRevoke
      );
      expect(statement.status).toBe(403);
      expect(JSON.stringify(statement.body)).toContain(XID_NOT_ALLOWED);

      const bare = await agree(null, allowRevoke, allowRevokeTids[1], revokeA);
      expect(bare.status).toBe(403);

      const read = await nextStatement(
        await agentWithToken(a.token),
        allowRevoke
      );
      expect(read.status).toBe(403);

      // Refused in the other gated conversation as well, as a member there.
      const voteElsewhere = await agree(
        await agentWithToken(a.token),
        allow,
        allowTid
      );
      expect(voteElsewhere.status).toBe(403);
      expect(JSON.stringify(voteElsewhere.body)).toContain(XID_NOT_ALLOWED);
      // Only the vote recorded before the removal; none from the refusal.
      expect(await voteRowCount(allowZid, pidElsewhere, allowTid)).toBe(1);

      await setAllowList(allowRevoke, [revokeA]);
      expect(await ownerListed(revokeA)).toBe(true);

      const readmitted = await agree(
        await agentWithToken(a.token),
        allowRevoke,
        allowRevokeTids[2]
      );
      expect(readmitted.status).toBe(200);
      expect(readmitted.body.currentPid).toBe(pid);

      const readmittedElsewhere = await agree(
        await agentWithToken(a.token),
        allow,
        allowTid
      );
      expect(readmittedElsewhere.status).toBe(200);
      expect(readmittedElsewhere.body.currentPid).toBe(pidElsewhere);
    });

    test("listed from one conversation of the owner is listed for all of them: admitted in another gated conversation, bare and by token; listing it there too is accepted", async () => {
      const a = await joinWithXid(allow, listedA);

      const bare = await agree(null, allowOther, allowOtherTid, listedA);
      expect(bare.status).toBe(200);
      expect(decode(bare.body.auth?.token).xid).toBe(listedA);
      expect(
        await participantRows(allowOtherZid, a.claims.uid as number)
      ).toEqual([{ pid: bare.body.currentPid, uid: a.claims.uid }]);

      const withToken = await agree(
        await agentWithToken(a.token),
        allowOther,
        allowOtherTid
      );
      expect(withToken.status).toBe(200);
      expect(withToken.body.currentPid).toBe(bare.body.currentPid);

      // Listing it for the second conversation as well is accepted and
      // changes nothing: one row per owner and xid.
      await setAllowList(allowOther, [listedA, listedOther]);
      expect(await ownerListed(listedA)).toBe(true);

      const other = await agree(null, allowOther, allowOtherTid, listedOther);
      expect(other.status).toBe(200);
      const claims = decode(other.body.auth?.token);
      expect(claims.xid).toBe(listedOther);
      expect(claims.conversation_id).toBe(allowOther);
      expect(await xidRows(ownerAUid, listedOther)).toHaveLength(1);

      // And the xid listed from allowOther is admitted in allow.
      const crossed = await agree(null, allow, allowTid, listedOther);
      expect(crossed.status).toBe(200);
    });

    test("an xid never listed for the owner is refused in every gated conversation, and nothing is written", async () => {
      const never = generateRandomXid();
      for (const [code, tid, zid] of [
        [allow, allowTid, allowZid],
        [allowOther, allowOtherTid, allowOtherZid],
      ] as [string, number, number][]) {
        const before = await participantCount(zid);
        const vote = await agree(null, code, tid, never);
        expect(vote.status).toBe(403);
        expect(JSON.stringify(vote.body)).toContain(XID_NOT_ALLOWED);
        const statement = await comment(null, code, never);
        expect(statement.status).toBe(403);
        expect(await participantCount(zid)).toBe(before);
      }
      expect(await xidRows(ownerAUid, never)).toHaveLength(0);
      expect(await ownerListed(never)).toBe(false);
    });

    test("GET /xidAllowList and its CSV for a conversation return the owner's whole list, with the pid each xid holds in that conversation", async () => {
      const joinedHere = await joinWithXid(allowOther, listedOther);
      const page = await ownerA
        .get("/api/v3/xidAllowList")
        .query({ conversation_id: allowOther, limit: 500 });
      expect(page.status).toBe(200);
      const rows: { xid: string; pid: number | null }[] = page.body.xids;
      const byXid = Object.fromEntries(rows.map((r) => [r.xid, r.pid]));
      // Listed from allow, from allowRevoke and from allowOther: all present.
      expect(byXid).toHaveProperty(listedA);
      expect(byXid).toHaveProperty(revokeB);
      expect(byXid).toHaveProperty(listedOther);
      expect(byXid[listedOther]).toBe(joinedHere.claims.pid);
      expect(page.body.pagination.total).toBe((await ownerList()).length);

      const csv = await ownerA
        .get("/api/v3/xidAllowList/csv")
        .query({ conversation_id: allowOther });
      expect(csv.status).toBe(200);
      const text: string = csv.text;
      expect(text.split("\n")[0]).toBe("pid,xid");
      expect(text).toContain(`,${listedA}`);
      expect(text).toContain(`${joinedHere.claims.pid},${listedOther}`);
    });

    test("an XID token for another owner's conversation carries no uid or pid: its xid is resolved under this owner, through this conversation's gates", async () => {
      const b = await joinWithXid(openB, crossOwnerXid);
      const uidUnderB = b.claims.uid as number;

      // xid_required: the xid is present, so the gate passes; a participant
      // of this owner's, not the token's uid.
      const admitted = await agree(
        await agentWithToken(b.token),
        xidReq,
        xidReqTid
      );
      expect(admitted.status).toBe(200);
      expect(await participantRows(xidReqZid, uidUnderB)).toHaveLength(0);
      const underA = await xidRows(ownerAUid, crossOwnerXid);
      expect(underA).toHaveLength(1);
      expect(underA[0].uid).not.toBe(uidUnderB);
      expect(await participantRows(xidReqZid, underA[0].uid)).toEqual([
        { pid: admitted.body.currentPid, uid: underA[0].uid },
      ]);
      const claims = decode(admitted.body.auth?.token);
      expect(claims.xid).toBe(crossOwnerXid);
      expect(claims.xid_participant).toBe(true);
      expect(claims.conversation_id).toBe(xidReq);
      expect(claims.uid).toBe(underA[0].uid);

      // Allow-listed (the xid is on owner A's list): admitted as the same
      // record under owner A, in both of A's gated conversations.
      for (const [code, zid] of [
        [allow, allowZid],
        [allowOther, allowOtherZid],
      ] as [string, number][]) {
        const listed = await agree(
          await agentWithToken(b.token),
          code,
          code === allow ? allowTid : allowOtherTid
        );
        expect(listed.status).toBe(200);
        expect(await participantRows(zid, uidUnderB)).toHaveLength(0);
        expect(await participantRows(zid, underA[0].uid)).toHaveLength(1);
      }

      // Another of owner B's xids, never listed by owner A: refused, nothing
      // written under A.
      const unlistedUnderA = generateRandomXid();
      const c = await joinWithXid(openB, unlistedUnderA);
      const refused = await agree(
        await agentWithToken(c.token),
        allowOther,
        allowOtherTid
      );
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).toContain(XID_NOT_ALLOWED);
      expect(
        await participantRows(allowOtherZid, c.claims.uid as number)
      ).toHaveLength(0);
      expect(await xidRows(ownerAUid, unlistedUnderA)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe("legitimate participation keeps working", () => {
    test("anonymous participant: first vote issues a token; the token votes, comments and reads as the same participant", async () => {
      const first = await agree(null, open, openTids[0]);
      expect(first.status).toBe(200);
      const token = first.body.auth?.token;
      expect(decode(token).anonymous_participant).toBe(true);
      const pid = first.body.currentPid;

      const again = await agree(await agentWithToken(token), open, openTids[1]);
      expect(again.status).toBe(200);
      expect(again.body.currentPid).toBe(pid);
      expect(again.body.auth).toBeUndefined();

      const statement = await comment(await agentWithToken(token), open);
      expect(statement.status).toBe(200);
      expect(statement.body.currentPid).toBe(pid);

      const read = await nextStatement(await agentWithToken(token), open);
      expect(read.status).toBe(200);
    });

    test("xid participant with its own token: votes and comments with or without the xid repeated in the request are the same participant", async () => {
      const xid = generateRandomXid();
      const p = await joinWithXid(open, xid);

      const v1 = await agree(await agentWithToken(p.token), open, openTids[0]);
      expect(v1.status).toBe(200);
      expect(v1.body.currentPid).toBe(p.claims.pid);
      expect(v1.body.auth).toBeUndefined();

      const v2 = await agree(
        await agentWithToken(p.token),
        open,
        openTids[1],
        xid
      );
      expect(v2.status).toBe(200);
      expect(v2.body.currentPid).toBe(p.claims.pid);

      const statement = await comment(await agentWithToken(p.token), open, xid);
      expect(statement.status).toBe(200);
      expect(statement.body.currentPid).toBe(p.claims.pid);

      const read = await nextStatement(await agentWithToken(p.token), open);
      expect(read.status).toBe(200);

      expect(await xidRows(ownerAUid, xid)).toHaveLength(1);
    });

    test("fresh allow-listed xid: a bare xid is admitted, gets a token bound to it, and keeps voting with that token (a credential-less request with the known xid still acts as that participant; this changes with the bare-xid decision)", async () => {
      const a = await joinWithXid(allowRevoke, revokeB);
      expect(await xidRows(ownerAUid, revokeB)).toHaveLength(1);

      const first = await agree(a.agent, allowRevoke, allowRevokeTids[0]);
      expect(first.status).toBe(200);
      expect(first.body.currentPid).toBe(a.claims.pid);

      const bare = await agree(null, allowRevoke, allowRevokeTids[1], revokeB);
      expect(bare.status).toBe(200);
      expect(bare.body.currentPid).toBe(a.claims.pid);
      expect(decode(bare.body.auth?.token).xid).toBe(revokeB);

      const statement = await comment(
        await agentWithToken(a.token),
        allowRevoke
      );
      expect(statement.status).toBe(200);
      expect(statement.body.currentPid).toBe(a.claims.pid);
    });

    test("invited participant: accepting an invite issues a token that votes and comments", async () => {
      const invites = await ownerA
        .get("/api/v3/treevite/invites")
        .query({ conversation_id: tree, status: 0, limit: 1 });
      expect(invites.status).toBe(200);
      const inviteCode = invites.body.invites[0].invite_code;

      const guest = await newAgent();
      const accepted = await guest
        .post("/api/v3/treevite/acceptInvite")
        .send({ conversation_id: tree, invite_code: inviteCode });
      expect(accepted.status).toBe(201);
      const token = accepted.body.auth?.token;
      expect(typeof token).toBe("string");

      const vote = await agree(await agentWithToken(token), tree, treeTid);
      expect(vote.status).toBe(200);
      expect(vote.body.currentPid).toBe(decode(token).pid);

      const statement = await comment(await agentWithToken(token), tree);
      expect(statement.status).toBe(200);

      // Without an invite the conversation is still closed to a newcomer.
      const stranger = await agree(null, tree, treeTid);
      expect(stranger.status).toBe(401);
    });

    test("the owner votes and comments in every conversation of theirs", async () => {
      for (const [code, tid] of [
        [open, openTids[2]],
        [allow, allowTid],
        [xidReq, xidReqTid],
        [tree, treeTid],
      ] as [string, number][]) {
        const vote = await agree(ownerA, code, tid);
        expect(vote.status).toBe(200);
        const statement = await comment(ownerA, code);
        expect(statement.status).toBe(200);
      }
    });

    test("a site moderator votes and comments in the open, allow-listed and xid-required conversations", async () => {
      for (const [code, tid] of [
        [open, openTids[2]],
        [allow, allowTid],
        [xidReq, xidReqTid],
      ] as [string, number][]) {
        const vote = await agree(moderator, code, tid);
        expect(vote.status).toBe(200);
        const statement = await comment(moderator, code);
        expect(statement.status).toBe(200);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("a request xid next to another token kind, and an xid that names nothing", () => {
    test("a request xid next to an anonymous token is ignored: the anonymous participant acts and no xid record is written", async () => {
      const first = await agree(null, open, openTids[0]);
      expect(first.status).toBe(200);
      const token = first.body.auth?.token;
      expect(decode(token).anonymous_participant).toBe(true);
      const pid = first.body.currentPid;

      const xid = generateRandomXid();
      const vote = await agree(
        await agentWithToken(token),
        open,
        openTids[1],
        xid
      );
      expect(vote.status).toBe(200);
      expect(vote.body.currentPid).toBe(pid);
      expect(vote.body.auth).toBeUndefined();

      const statement = await comment(await agentWithToken(token), open, xid);
      expect(statement.status).toBe(200);
      expect(statement.body.currentPid).toBe(pid);

      expect(await xidRows(ownerAUid, xid)).toHaveLength(0);
    });

    test("an empty or whitespace-only xid next to an XID token names nothing: the token's participant acts and no token is issued (open conversation)", async () => {
      const xid = generateRandomXid();
      const p = await joinWithXid(open, xid);

      for (const blank of ["", "   ", " \t "]) {
        const vote = await agree(
          await agentWithToken(p.token),
          open,
          openTids[0],
          blank
        );
        expect(vote.status).toBe(200);
        expect(vote.body.currentPid).toBe(p.claims.pid);
        expect(vote.body.auth).toBeUndefined();
      }

      const statement = await comment(await agentWithToken(p.token), open, "");
      expect(statement.status).toBe(200);
      expect(statement.body.currentPid).toBe(p.claims.pid);

      expect(await xidRows(ownerAUid, "")).toHaveLength(0);
      expect(await participantRows(openZid, p.claims.uid as number)).toEqual([
        { pid: p.claims.pid, uid: p.claims.uid },
      ]);
    });

    test("an empty or whitespace-only xid next to an XID token keeps the participant in an xid_required conversation", async () => {
      const xid = generateRandomXid();
      const p = await joinWithXid(xidReq, xid);

      for (const blank of ["", "  "]) {
        const vote = await agree(
          await agentWithToken(p.token),
          xidReq,
          xidReqTid,
          blank
        );
        expect(vote.status).toBe(200);
        expect(vote.body.currentPid).toBe(p.claims.pid);
        expect(vote.body.auth).toBeUndefined();
      }

      const statement = await comment(
        await agentWithToken(p.token),
        xidReq,
        ""
      );
      expect(statement.status).toBe(200);
      expect(statement.body.currentPid).toBe(p.claims.pid);
    });
  });

  // ---------------------------------------------------------------------------
  describe("use_xid_whitelist is fixed once participation has started", () => {
    const FIXED = "polis_err_xid_whitelist_fixed_after_start";

    const settingsOf = async (zid: number) =>
      (
        await pool.query(
          "select use_xid_whitelist, topic from conversations where zid = $1",
          [zid]
        )
      ).rows[0];

    test("before any participant from outside the owner's site: switched on and off freely, the owner's own seeding included", async () => {
      const code = await createConversation(ownerA, {
        topic: "xid identity: toggle before start",
      });
      const zid = await zidOf(code);
      expect((await settingsOf(zid)).use_xid_whitelist).toBe(false);

      const on = await updateConversation(ownerA, {
        conversation_id: code,
        use_xid_whitelist: true,
      });
      expect(on.status).toBe(200);
      expect((await settingsOf(zid)).use_xid_whitelist).toBe(true);

      const off = await updateConversation(ownerA, {
        conversation_id: code,
        use_xid_whitelist: false,
      });
      expect(off.status).toBe(200);
      expect((await settingsOf(zid)).use_xid_whitelist).toBe(false);

      // Seeding a statement gives the owner a participant row; that is not
      // the start of participation.
      await seed(ownerA, code, "seed before configuration");
      expect(await participantCount(zid)).toBeGreaterThan(0);
      const afterSeed = await updateConversation(ownerA, {
        conversation_id: code,
        use_xid_whitelist: true,
      });
      expect(afterSeed.status).toBe(200);
      expect((await settingsOf(zid)).use_xid_whitelist).toBe(true);
    });

    test("after a participant joined: a change in either direction is refused with its own code, and nothing in the update is applied", async () => {
      // off -> on, on a conversation an anonymous participant has joined
      const code = await createConversation(ownerA, {
        topic: "xid identity: toggle after start",
      });
      const zid = await zidOf(code);
      const tid = await seed(ownerA, code, "seed");
      expect((await agree(null, code, tid)).status).toBe(200);

      const refused = await updateConversation(ownerA, {
        conversation_id: code,
        use_xid_whitelist: true,
        topic: "renamed in the refused update",
      });
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toContain(FIXED);
      const after = await settingsOf(zid);
      expect(after.use_xid_whitelist).toBe(false);
      expect(after.topic).toBe("xid identity: toggle after start");

      // on -> off, on a listed conversation that has participants
      expect(await participantCount(allowRevokeZid)).toBeGreaterThan(0);
      const refusedOff = await updateConversation(ownerA, {
        conversation_id: allowRevoke,
        use_xid_whitelist: false,
      });
      expect(refusedOff.status).toBe(409);
      expect(JSON.stringify(refusedOff.body)).toContain(FIXED);
      expect((await settingsOf(allowRevokeZid)).use_xid_whitelist).toBe(true);
    });

    test("after a participant joined: an update that leaves use_xid_whitelist as it is still applies", async () => {
      const code = await createConversation(ownerA, {
        topic: "xid identity: unchanged after start",
      });
      const zid = await zidOf(code);
      const tid = await seed(ownerA, code, "seed");
      expect((await agree(null, code, tid)).status).toBe(200);

      const sameValue = await updateConversation(ownerA, {
        conversation_id: code,
        use_xid_whitelist: false,
        topic: "renamed with the setting repeated",
      });
      expect(sameValue.status).toBe(200);
      expect(await settingsOf(zid)).toEqual({
        use_xid_whitelist: false,
        topic: "renamed with the setting repeated",
      });

      const withoutField = await updateConversation(ownerA, {
        conversation_id: code,
        topic: "renamed without the setting",
      });
      expect(withoutField.status).toBe(200);
      expect((await settingsOf(zid)).topic).toBe("renamed without the setting");

      const keepOn = await updateConversation(ownerA, {
        conversation_id: allowRevoke,
        use_xid_whitelist: true,
        description: "still listed",
      });
      expect(keepOn.status).toBe(200);
      expect((await settingsOf(allowRevokeZid)).use_xid_whitelist).toBe(true);
    });
  });
});
