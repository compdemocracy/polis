import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  initializeParticipant,
  initializeParticipantWithXid,
  newAgent,
  setupAuthAndConvo,
  submitVote,
} from "../setup/api-test-helpers";
import { toWire, Vote } from "../setup/vote-wire";

/**
 * GET /api/v3/votes/famous: the requester's own row.
 *
 * The route answers with the participants the opinion map shows by name or
 * picture, and with the requester's own row, marked `isSelf`. The featured
 * participants are kept 30 seconds for a conversation, a limit and a math
 * tick; the requester's own row is decided on every request and is never
 * kept. So within those 30 seconds each requester gets their own row and
 * nobody else's, and a requester who is no participant with a vote gets no
 * `isSelf` row at all.
 *
 * Nothing here has math, so nobody is placed in a cluster: a reply holds the
 * requester's own row or nothing. Every test asks at a math tick of its own,
 * which gives it kept rows of its own.
 *
 * A participant's votes are one letter a statement, as long as the greatest
 * statement number among everyone read with them. The conversation's owner
 * can be among those (the test database is shared, and an external id given
 * to the owner's account elsewhere features them here, unplaced and so not
 * shown). Every voter therefore also votes on the conversation's last
 * statement, which makes each string as long as it can be, whoever else is
 * read.
 */
describe("GET /api/v3/votes/famous: the requester's own row", () => {
  let conversationId: string;
  type Voter = { agent: Agent; pid: number; letters: string };
  let first: Voter;
  let second: Voter;
  let withoutVote: Agent;
  let noCredential: Agent;

  const LETTER: Record<Vote, string> = { agree: "a", disagree: "d", pass: "p" };

  /**
   * A participant who votes as told, and the letters the route gives them.
   * Their participant number is the one each vote's reply names; every voter
   * here votes at least once.
   */
  async function voter(votes: Array<[number, Vote]>): Promise<Voter> {
    const { agent } = await initializeParticipant(conversationId);
    let pid: number | undefined;
    const letters = Array(Math.max(...votes.map(([tid]) => tid)) + 1).fill("u");
    for (const [tid, vote] of votes) {
      const res = await submitVote(agent, {
        conversation_id: conversationId,
        tid,
        vote: toWire(vote),
      });
      expect(res.status).toBe(200);
      pid = res.body.currentPid;
      letters[tid] = LETTER[vote];
    }
    return { agent, pid, letters: letters.join("") };
  }

  /** The whole reply to a requester whose own row is the only one. */
  function ownRowOnly(v: Voter): string {
    return (
      `{"${v.pid}":{"priority":1000,"x_profile_image_url":null,"xid":null,` +
      `"x_name":null,"x_email":null,"pid":${v.pid},"isSelf":true,` +
      `"votes":"${v.letters}"}}`
    );
  }

  function famous(agent: Agent, tick: number) {
    return agent.get(
      `/api/v3/votes/famous?conversation_id=${conversationId}&math_tick=${tick}`
    );
  }

  beforeAll(async () => {
    const setup = await setupAuthAndConvo({
      commentCount: 3,
      conversationOptions: { is_anon: false },
    });
    conversationId = setup.conversationId;
    const [c0, c1, last] = setup.commentIds;
    expect(last).toBeGreaterThan(Math.max(c0, c1));
    first = await voter([
      [c0, "agree"],
      [c1, "disagree"],
      [last, "pass"],
    ]);
    second = await voter([
      [c1, "pass"],
      [last, "agree"],
    ]);
    expect(second.pid).not.toBe(first.pid);
    // A participant from the moment they arrive, with a token and no vote.
    const arrived = await initializeParticipantWithXid(conversationId);
    expect(arrived.body.ptpt.pid).toBeGreaterThanOrEqual(0);
    withoutVote = arrived.agent;
    noCredential = await newAgent();
  });

  test("the first requester gets exactly their own row", async () => {
    const res = await famous(first.agent, 101);
    expect(res.status).toBe(200);
    expect(res.text).toBe(ownRowOnly(first));
  });

  test("a second requester within the 30 seconds gets their own row, not the first's", async () => {
    expect((await famous(first.agent, 102)).text).toBe(ownRowOnly(first));
    const res = await famous(second.agent, 102);
    expect(res.status).toBe(200);
    expect(res.text).toBe(ownRowOnly(second));
    // And the first requester, asking again, still gets their own.
    expect((await famous(first.agent, 102)).text).toBe(ownRowOnly(first));
  });

  test("a requester without a credential within the 30 seconds gets no isSelf row", async () => {
    expect((await famous(first.agent, 103)).text).toBe(ownRowOnly(first));
    const res = await famous(noCredential, 103);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("isSelf");
    expect(res.text).toBe("{}");
  });

  test("a participant without a vote within the 30 seconds gets no isSelf row", async () => {
    expect((await famous(first.agent, 104)).text).toBe(ownRowOnly(first));
    const res = await famous(withoutVote, 104);
    expect(res.status).toBe(200);
    expect(res.text).toBe("{}");
  });

  test("a requester gets their own row after a requester who has none", async () => {
    expect((await famous(noCredential, 105)).text).toBe("{}");
    expect((await famous(second.agent, 105)).text).toBe(ownRowOnly(second));
  });

  test("a limit of zero is nobody, the requester included", async () => {
    const res = await first.agent.get(
      `/api/v3/votes/famous?conversation_id=${conversationId}&math_tick=106&ptptoiLimit=0`
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe("{}");
  });

  test("participationInit's famous is the requester's own row as well", async () => {
    const init = (agent: Agent) =>
      agent.get(
        `/api/v3/participationInit?conversation_id=${conversationId}&pid=-1&lang=en`
      );
    const one = await init(first.agent);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body.famous)).toBe(ownRowOnly(first));
    const two = await init(second.agent);
    expect(two.status).toBe(200);
    expect(JSON.stringify(two.body.famous)).toBe(ownRowOnly(second));
    const none = await init(noCredential);
    expect(none.status).toBe(200);
    expect(none.body.famous).toEqual({});
  });
});
