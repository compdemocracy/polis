/**
 * GET /api/v3/comments?moderation=true is the moderation list, and only the
 * conversation's moderators get all of it.
 *
 * The moderation list returns every statement of a conversation with its
 * moderation state (mod, active, velocity) and its author's pid: rejected
 * statements, and under strict moderation the statements still waiting for a
 * moderator. Public report pages and the participation page's topic list also
 * send moderation=true, without moderator rights, so a caller who does not
 * moderate the conversation is not refused. That caller gets the statements
 * participants can see, with the plain list's fields, plus the vote counts a
 * report page reads. This file pins that, for one conversation under strict
 * moderation and one without:
 *   - a request without a login gets exactly the plain list's statements and
 *     fields; mod, modIn and mod_gt only narrow that set, and the paginated
 *     form counts and pages the same set;
 *   - a participant's token, and a signed-in account that neither owns nor
 *     moderates the conversation, get what a request without a login gets;
 *   - the owner gets every statement with its pid and moderation state, as
 *     before;
 *   - the plain list issues the same number of statements as before for every
 *     caller and never checks moderator rights; the moderation list checks
 *     them once for a signed-in caller and never for a request without a login.
 *
 * Every agent here is built on this file's own app instance (newAgent), so the
 * statement count below sees each query the request makes.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent, Response } from "supertest";
import { Client } from "pg";
import {
  createConversation,
  getOidcToken,
  newAgent,
  submitComment,
  submitVote,
  wait,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { WIRE_AGREE, WIRE_DISAGREE } from "../setup/vote-wire";
import { polisTypes } from "../../src/utils/common";

/** The fields of the plain list (GET /api/v3/comments without moderation). */
const PLAIN_FIELDS = [
  "created",
  "is_meta",
  "is_seed",
  "lang",
  "original_id",
  "pid",
  "quote_src_url",
  "tid",
  "txt",
];
const VOTE_COUNT_FIELDS = [
  "agree_count",
  "count",
  "disagree_count",
  "pass_count",
];
const MODERATION_FIELDS = ["active", "conversation_id", "mod", "velocity"];

/** The moderator check's statement (isModerator, src/utils/common.ts). */
const MODERATOR_CHECK = /owner in \(select uid from users where site_id/;

/** Long enough for anything a GET schedules after it answers. */
const SETTLE_MS = 300;
/** A window with no statement sent, before each measurement. */
const QUIET_MS = 300;

// Every statement the app sends goes through a pg Client's query().
let statements: string[] | null = null;
const ClientPrototype = Client.prototype as unknown as {
  query: (...args: unknown[]) => unknown;
};
const hadOwnQuery = Object.prototype.hasOwnProperty.call(
  ClientPrototype,
  "query"
);
const realQuery = ClientPrototype.query;

beforeAll(() => {
  ClientPrototype.query = function (this: Client, ...args: unknown[]) {
    if (statements) {
      const q = args[0] as string | { text?: string };
      statements.push(typeof q === "string" ? q : String(q?.text));
    }
    return realQuery.apply(this, args);
  };
});
afterAll(() => {
  if (hadOwnQuery) ClientPrototype.query = realQuery;
  else delete (ClientPrototype as { query?: unknown }).query;
});

/**
 * Wait until the app has sent nothing for QUIET_MS, so that work an earlier
 * request scheduled is not counted against the next one.
 */
async function quiet(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    statements = [];
    await wait(QUIET_MS);
    const sent = statements.length;
    statements = null;
    if (sent === 0) return;
  }
  throw new Error("the app kept sending statements");
}

/** The statements `work` sent, including what it scheduled. */
async function statementsOf(
  work: () => PromiseLike<Response>
): Promise<string[]> {
  await quiet();
  statements = [];
  try {
    const response = await work();
    expect(response.status).toBe(200);
    await wait(SETTLE_MS);
    return [...statements];
  } finally {
    statements = null;
  }
}

type Item = Record<string, unknown> & { tid: number; txt: string };
const byTid = (items: Item[]) => [...items].sort((a, b) => a.tid - b.tid);
const tidsOf = (items: Item[]) => byTid(items).map((c) => c.tid);
const keysOf = (item: Item) => Object.keys(item).sort();

interface Fixture {
  conversationId: string;
  zid: number;
  /** Accepted seed from the owner. */
  accepted: number;
  /** A participant's statement the owner rejected. */
  rejected: number;
  /** A participant's statement no moderator has looked at. */
  unmoderated: number;
  /** A participant's statement the owner accepted and then deactivated. */
  inactive: number;
  texts: Record<"accepted" | "rejected" | "unmoderated" | "inactive", string>;
}

describe("the moderation list: whole for moderators, participant-visible for everyone else", () => {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let owner: Agent;
  let stranger: Agent;
  /** A participant of each conversation, holding the token its vote issued. */
  const participants = new Map<Fixture, Agent>();
  let strict: Fixture;
  let open: Fixture;

  const signedIn = async (index: number): Promise<Agent> => {
    const user = getPooledTestUser(index);
    const agent = await newAgent();
    agent.set(
      "Authorization",
      `Bearer ${await getOidcToken({
        email: user.email,
        password: user.password,
      })}`
    );
    // Make sure the account's user row exists before anything reads it.
    expect((await agent.get("/api/v3/users")).status).toBe(200);
    return agent;
  };

  const moderate = async (
    conversationId: string,
    tid: number,
    mod: number,
    active = true
  ) => {
    const r: Response = await owner.put("/api/v3/comments").send({
      conversation_id: conversationId,
      tid,
      active,
      mod,
      is_meta: false,
      velocity: 1,
    });
    expect(r.status).toBe(200);
  };

  /** A participant who votes on the seed first, then holds its token. */
  const participantWhoVoted = async (
    conversationId: string,
    tid: number,
    vote: typeof WIRE_AGREE | typeof WIRE_DISAGREE
  ): Promise<Agent> => {
    const agent = await newAgent();
    const r = await submitVote(agent, {
      conversation_id: conversationId,
      tid,
      vote,
    });
    expect(r.status).toBe(200);
    return agent;
  };

  async function fixture(name: string, strictModeration: boolean) {
    const conversationId = await createConversation(owner, {
      topic: `Moderation list visibility, ${name} ${stamp}`,
      strict_moderation: strictModeration,
    });
    const zid = Number(
      (
        await pool.query("SELECT zid FROM zinvites WHERE zinvite = $1", [
          conversationId,
        ])
      ).rows[0].zid
    );
    const texts = {
      accepted: `Accepted seed, ${name} ${stamp}`,
      rejected: `Rejected statement, ${name} ${stamp}`,
      unmoderated: `Unmoderated statement, ${name} ${stamp}`,
      inactive: `Inactive statement, ${name} ${stamp}`,
    };
    const seed = await submitComment(owner, {
      conversation_id: conversationId,
      txt: texts.accepted,
      is_seed: true,
    });
    expect(seed.status).toBe(200);
    const accepted: number = seed.body.tid;

    const authors = [
      await participantWhoVoted(conversationId, accepted, WIRE_AGREE),
      await participantWhoVoted(conversationId, accepted, WIRE_DISAGREE),
      await participantWhoVoted(conversationId, accepted, WIRE_AGREE),
    ];
    const post = async (author: Agent, txt: string): Promise<number> => {
      const r = await submitComment(author, {
        conversation_id: conversationId,
        txt,
      });
      expect(r.status).toBe(200);
      return r.body.tid;
    };
    const rejected = await post(authors[0], texts.rejected);
    const unmoderated = await post(authors[1], texts.unmoderated);
    const inactive = await post(authors[2], texts.inactive);
    await moderate(conversationId, rejected, polisTypes.mod.ban);
    await moderate(conversationId, inactive, polisTypes.mod.ok, false);

    // What the database holds, so the expectations below rest on it.
    const rows = (
      await pool.query(
        "SELECT tid, mod, active FROM comments WHERE zid = $1 ORDER BY tid",
        [zid]
      )
    ).rows;
    expect(rows).toEqual([
      { tid: accepted, mod: polisTypes.mod.ok, active: true },
      { tid: rejected, mod: polisTypes.mod.ban, active: true },
      { tid: unmoderated, mod: polisTypes.mod.unmoderated, active: true },
      { tid: inactive, mod: polisTypes.mod.ok, active: false },
    ]);
    return {
      conversationId,
      zid,
      accepted,
      rejected,
      unmoderated,
      inactive,
      texts,
    } as Fixture;
  }

  /** The statements participants see in each conversation. */
  const visible = (f: Fixture) =>
    f === strict ? [f.accepted] : [f.accepted, f.unmoderated];
  const hidden = (f: Fixture) =>
    f === strict
      ? [f.texts.rejected, f.texts.unmoderated, f.texts.inactive]
      : [f.texts.rejected, f.texts.inactive];

  const list = (f: Fixture, query = "") =>
    `/api/v3/comments?conversation_id=${f.conversationId}${query}`;

  beforeAll(async () => {
    owner = await signedIn(2);
    // A distinct signed-in account, on a site of its own: neither owner nor
    // moderator of the conversations below.
    stranger = await signedIn(3);
    strict = await fixture("strict", true);
    open = await fixture("open", false);
    for (const f of [strict, open])
      participants.set(
        f,
        await participantWhoVoted(f.conversationId, f.accepted, WIRE_AGREE)
      );
  });

  describe.each([
    ["under strict moderation", () => strict],
    ["without strict moderation", () => open],
  ] as Array<[string, () => Fixture]>)("%s", (_label, current) => {
    test("a request without a login gets the plain list's statements and fields", async () => {
      const f = current();
      const anonymous = await newAgent();
      const plain: Response = await anonymous.get(list(f));
      const moderation: Response = await anonymous.get(
        list(f, "&moderation=true")
      );
      expect(plain.status).toBe(200);
      expect(moderation.status).toBe(200);
      expect(tidsOf(plain.body)).toEqual(visible(f));
      expect(byTid(moderation.body)).toEqual(byTid(plain.body));
      for (const item of moderation.body as Item[])
        expect(keysOf(item)).toEqual(PLAIN_FIELDS);
      for (const txt of hidden(f)) expect(moderation.text).not.toContain(txt);
    });

    test("with include_voting_patterns, the vote counts a report reads stay", async () => {
      const f = current();
      const query = "&moderation=true&include_voting_patterns=true";
      const anonymous: Response = await (await newAgent()).get(list(f, query));
      const asOwner: Response = await owner.get(list(f, query));
      expect(anonymous.status).toBe(200);
      expect(tidsOf(anonymous.body)).toEqual(visible(f));
      const ownerItems = new Map(
        (asOwner.body as Item[]).map((c) => [c.tid, c])
      );
      for (const item of anonymous.body as Item[]) {
        expect(keysOf(item)).toEqual(
          [...PLAIN_FIELDS, ...VOTE_COUNT_FIELDS].sort()
        );
        const own = ownerItems.get(item.tid)!;
        for (const field of VOTE_COUNT_FIELDS)
          expect(item[field]).toBe(own[field]);
      }
      // The seed's votes are counted: two agrees and a disagree from the
      // authors, plus the participant's agree.
      const seed = (anonymous.body as Item[]).find(
        (c) => c.tid === f.accepted
      )!;
      expect(seed.count).toBe(4);
      expect(seed.agree_count).toBe(3);
      expect(seed.disagree_count).toBe(1);
      for (const txt of hidden(f)) expect(anonymous.text).not.toContain(txt);
    });

    test("mod, modIn and mod_gt only narrow what a request without a login gets", async () => {
      const f = current();
      const anonymous = await newAgent();
      const tids = async (query: string) => {
        const r: Response = await anonymous.get(
          list(f, `&moderation=true${query}`)
        );
        expect(r.status).toBe(200);
        for (const txt of hidden(f)) expect(r.text).not.toContain(txt);
        return tidsOf(r.body);
      };
      expect(await tids(`&mod=${polisTypes.mod.ban}`)).toEqual([]);
      expect(await tids(`&mod=${polisTypes.mod.unmoderated}`)).toEqual(
        f === strict ? [] : [f.unmoderated]
      );
      expect(await tids(`&mod=${polisTypes.mod.ok}`)).toEqual([f.accepted]);
      expect(await tids("&modIn=false")).toEqual([]);
      expect(await tids("&modIn=true")).toEqual(visible(f));
      // A report page's own query, at its "every statement" level.
      expect(await tids("&mod_gt=-2&include_voting_patterns=true")).toEqual(
        visible(f)
      );
    });

    test("the paginated form counts and pages the same statements", async () => {
      const f = current();
      const anonymous = await newAgent();
      const plain: Response = await anonymous.get(list(f, "&limit=10"));
      const moderation: Response = await anonymous.get(
        list(f, "&moderation=true&limit=10")
      );
      expect(moderation.status).toBe(200);
      expect(tidsOf(moderation.body.comments)).toEqual(visible(f));
      expect(byTid(moderation.body.comments)).toEqual(
        byTid(plain.body.comments)
      );
      expect(moderation.body.pagination.total).toBe(visible(f).length);
      expect(plain.body.pagination.total).toBe(visible(f).length);
      for (const txt of hidden(f)) expect(moderation.text).not.toContain(txt);
    });

    test("a participant's token gets what a request without a login gets", async () => {
      const f = current();
      for (const query of [
        "&moderation=true",
        "&moderation=true&include_voting_patterns=true",
      ]) {
        const anonymous: Response = await (
          await newAgent()
        ).get(list(f, query));
        const asParticipant: Response = await participants
          .get(f)!
          .get(list(f, query));
        expect(asParticipant.status).toBe(200);
        expect(byTid(asParticipant.body)).toEqual(byTid(anonymous.body));
        for (const txt of hidden(f))
          expect(asParticipant.text).not.toContain(txt);
      }
    });

    test("a signed-in account that does not moderate gets what a request without a login gets", async () => {
      const f = current();
      for (const query of [
        "&moderation=true",
        "&moderation=true&include_voting_patterns=true",
        `&moderation=true&include_voting_patterns=false&mod=${polisTypes.mod.ban}&limit=50&offset=0`,
      ]) {
        const anonymous: Response = await (
          await newAgent()
        ).get(list(f, query));
        const asStranger: Response = await stranger.get(list(f, query));
        expect(asStranger.status).toBe(200);
        expect(asStranger.body).toEqual(anonymous.body);
        for (const txt of hidden(f)) expect(asStranger.text).not.toContain(txt);
      }
    });

    test("the owner gets every statement with its pid and moderation state", async () => {
      const f = current();
      const r: Response = await owner.get(list(f, "&moderation=true"));
      expect(r.status).toBe(200);
      const expected = (
        await pool.query(
          `SELECT tid, pid, mod, active, velocity, txt FROM comments
            WHERE zid = $1 ORDER BY tid`,
          [f.zid]
        )
      ).rows;
      expect(
        byTid(r.body).map(({ tid, pid, mod, active, velocity, txt }) => ({
          tid,
          pid,
          mod,
          active,
          velocity,
          txt,
        }))
      ).toEqual(expected);
      expect(tidsOf(r.body)).toEqual([
        f.accepted,
        f.rejected,
        f.unmoderated,
        f.inactive,
      ]);
      for (const item of r.body as Item[]) {
        expect(keysOf(item)).toEqual(
          [...PLAIN_FIELDS, ...MODERATION_FIELDS].sort()
        );
        expect(item.conversation_id).toBe(f.conversationId);
      }
      // The admin console's queue of rejected statements.
      const queue: Response = await owner.get(
        list(
          f,
          `&moderation=true&include_voting_patterns=false&mod=${polisTypes.mod.ban}&limit=50&offset=0`
        )
      );
      expect(queue.status).toBe(200);
      expect(tidsOf(queue.body.comments)).toEqual([f.rejected]);
      expect(queue.body.pagination.total).toBe(1);
    });
  });

  describe("statements issued", () => {
    // Counts measured on the server before the moderation list was narrowed,
    // and unchanged by it. The owner's four more are its sign-in's user lookup.
    // The participation page's plain reads gain no query, and a report page
    // read without a login gains none either.
    const PLAIN_LIST_STATEMENTS = {
      anonymous: 3,
      participant: 3,
      owner: 7,
    };
    const MODERATION_QUERIES = [
      "&moderation=true",
      "&moderation=true&include_voting_patterns=true",
      "&moderation=true&limit=10",
    ];
    const ANONYMOUS_MODERATION_STATEMENTS = {
      "&moderation=true": 3,
      "&moderation=true&include_voting_patterns=true": 3,
      "&moderation=true&limit=10": 5,
    };
    const isCheck = (s: string) => MODERATOR_CHECK.test(s);

    test("the plain list issues as many statements as before and never checks moderator rights", async () => {
      const anonymous = await newAgent();
      const callers: Record<keyof typeof PLAIN_LIST_STATEMENTS, Agent> = {
        anonymous,
        participant: participants.get(strict)!,
        owner,
      };
      // One read first, so the conversation id is cached as it is in service.
      expect((await anonymous.get(list(strict))).status).toBe(200);
      const measured: Record<string, number> = {};
      for (const [name, agent] of Object.entries(callers)) {
        const sent = await statementsOf(() => agent.get(list(strict)));
        expect(sent.filter(isCheck)).toEqual([]);
        measured[name] = sent.length;
      }
      expect(measured).toEqual(PLAIN_LIST_STATEMENTS);
    });

    test("the moderation list checks moderator rights once for a signed-in caller, and costs a request without a login nothing more", async () => {
      const anonymous = await newAgent();
      expect((await anonymous.get(list(strict))).status).toBe(200);
      const checks = async (agent: Agent, query: string) =>
        (await statementsOf(() => agent.get(list(strict, query)))).filter(
          isCheck
        ).length;
      const measured: Record<string, number> = {};
      for (const query of MODERATION_QUERIES) {
        const sent = await statementsOf(() =>
          anonymous.get(list(strict, query))
        );
        expect(sent.filter(isCheck)).toEqual([]);
        measured[query] = sent.length;
      }
      expect(measured).toEqual(ANONYMOUS_MODERATION_STATEMENTS);
      for (const query of MODERATION_QUERIES) {
        expect(await checks(participants.get(strict)!, query)).toBe(1);
        expect(await checks(stranger, query)).toBe(1);
        expect(await checks(owner, query)).toBe(1);
      }
    });
  });
});
