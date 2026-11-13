import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * GET /api/v3/votes/famous and participationInit's famous, through the real
 * doFamousQuery (src/server-helpers.ts) and the real getSocialParticipants
 * (src/participant.ts): a requester's reply is the same bytes whether they ask
 * first in a conversation's 30 seconds or after any other requester.
 *
 * doFamousQuery writes onto the rows it is given, in place: it nests the
 * external id into xInfo, marks the row at priority 1000 isSelf, and puts the
 * votes and the cluster on each row. The featured participants are kept and
 * shared by every request of the 30 seconds, so a reply that wrote a
 * requester's mark onto a kept row would show it to everyone after. A
 * requester who is one of the featured participants is the case to watch:
 * their own row is a copy of a kept one.
 *
 * The database and the math are stand-ins. Every participant here has voted
 * on the conversation's last statement, so their letters have one length
 * whoever is read with them.
 */

type Row = Record<string, unknown>;

const queryP_metered_readOnly =
  jest.fn<(name: string, sql: string, params: unknown[]) => Promise<Row[]>>();
const queryP_readOnly =
  jest.fn<(sql: string, params: unknown[]) => Promise<Row[]>>();

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP_metered_readOnly, queryP_readOnly },
}));
jest.mock("../../src/db/sql", () => ({
  __esModule: true,
  sql_participants_extended: {},
}));
jest.mock("../../src/db/activity", () => ({
  __esModule: true,
  conversationModifiedSql: () => "",
}));
jest.mock("../../src/session", () => ({
  __esModule: true,
  encrypt: jest.fn(),
}));
jest.mock("../../src/user", () => ({
  __esModule: true,
  getPidPromise: jest.fn(),
  getUserInfoForUid2: jest.fn(),
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { mathEnv: "test" },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../src/utils/common", () => ({
  __esModule: true,
  ifDefinedFirstElseSecond: (a: unknown, b: unknown) =>
    a === undefined ? b : a,
}));
jest.mock("../../src/utils/zinvite", () => ({
  __esModule: true,
  getZinvite: jest.fn(),
  getZinvites: jest.fn(),
}));
jest.mock("../../src/email/senders", () => ({
  __esModule: true,
  sendTextEmail: jest.fn(),
}));
jest.mock("../../src/routes/metadata", () => ({
  __esModule: true,
  getConversationHasMetadata: jest.fn(),
}));
jest.mock("../../src/conversation", () => ({
  __esModule: true,
  getConversationInfo: async () => ({ is_anon: false }),
}));
jest.mock("../../src/utils/mathBundle", () => ({
  __esModule: true,
  getMathBundle: async () => ({}),
}));
jest.mock("../../src/utils/pca", () => ({
  __esModule: true,
  // No math document: no featured comments, so no featured authors.
  presentExistingMathBundle: async () => null,
}));
jest.mock("../../src/routes/math", () => ({
  __esModule: true,
  // Everyone read is placed in a cluster: a featured participant is shown.
  getBidsForPids: async (_zid: number, _tick: number, pids: number[]) =>
    Object.fromEntries(pids.map((pid) => [pid, 10 + pid])),
}));

import { doFamousQuery } from "../../src/server-helpers";
import { semanticToStorage } from "../../src/votes/convention";

// The featured ranking, as the featured statement returns it (the account
// last): a moderator's pin, and two participants with an external id and a
// picture.
function featured(): Row[] {
  return [
    {
      priority: 999,
      x_profile_image_url: null,
      xid: null,
      x_name: null,
      x_email: null,
      pid: 4,
      uid: 40,
    },
    {
      priority: 100,
      x_profile_image_url: "https://example.invalid/2.png",
      xid: "id-2",
      x_name: "Two",
      x_email: null,
      pid: 2,
      uid: 50,
    },
    {
      priority: 100,
      x_profile_image_url: "https://example.invalid/3.png",
      xid: "id-3",
      x_name: "Three",
      x_email: "three@example.invalid",
      pid: 3,
      uid: 30,
    },
  ];
}

// Participants with at least one vote, by account. 50, 30 and 40 are featured.
const VOTERS: Record<number, number> = { 70: 7, 71: 8, 50: 2, 30: 3, 40: 4 };
const LAST_TID = 5;

// Each participant's votes: agree on their own number modulo the statements,
// pass on the last statement.
function votesOf(pid: number): Row[] {
  return [
    { pid, tid: pid % LAST_TID, vote: semanticToStorage("agree") },
    { pid, tid: LAST_TID, vote: semanticToStorage("pass") },
  ];
}

let zid = 990000;

beforeEach(() => {
  queryP_metered_readOnly.mockReset();
  queryP_metered_readOnly.mockImplementation(async (name, _sql, params) => {
    if (name === "getSocialParticipants") {
      return featured().slice(0, params[1] as number);
    }
    if (name === "getOwnParticipantRows") {
      const pid = VOTERS[params[1] as number];
      return pid === undefined
        ? []
        : [
            {
              priority: 1000,
              x_profile_image_url: null,
              xid: null,
              x_name: null,
              x_email: null,
              pid,
            },
          ];
    }
    throw new Error(`unexpected statement ${name}`);
  });
  queryP_readOnly.mockReset();
  queryP_readOnly.mockImplementation(async (sql) => {
    const pids = /pid in \(([0-9,]+)\)/.exec(sql);
    if (!pids) throw new Error(`unexpected statement ${sql}`);
    return pids[1].split(",").map(Number).flatMap(votesOf);
  });
});

/** One reply, as Express writes it. */
async function reply(z: number, uid: number | undefined, limit = 30) {
  return JSON.stringify(
    await doFamousQuery({ zid: z, uid, math_tick: 5, ptptoiLimit: limit })
  );
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ])
  );
}

// No credential; two participants who are not featured; two featured ones;
// an account that takes no part.
const REQUESTERS: Array<number | undefined> = [undefined, 70, 71, 50, 40, 999];

describe("a famous reply is the same in any order of requesters", () => {
  test.each([30, 3, 1])(
    "at a limit of %i, each requester's bytes are those of asking first",
    async (limit) => {
      // Each requester asking first, in a conversation of their own.
      const first = new Map<number | undefined, string>();
      for (const uid of REQUESTERS)
        first.set(uid, await reply(++zid, uid, limit));

      // A requester's own row is the only row marked, and a requester with no
      // row of their own has none.
      for (const uid of REQUESTERS) {
        const body = JSON.parse(first.get(uid)!);
        const marked = Object.values(body).filter(
          (r: any) => r.isSelf === true
        ) as any[];
        const own = uid === undefined ? undefined : VOTERS[uid];
        expect(marked.map((r) => r.pid)).toEqual(
          own === undefined ? [] : [own]
        );
        for (const r of marked) expect(r.priority).toBe(1000);
      }

      // Every order of the six within one 30 seconds: every reply is the one
      // its requester gets asking first.
      let orders = 0;
      for (const order of permutations(REQUESTERS)) {
        const z = ++zid;
        for (const uid of order) {
          expect([uid, await reply(z, uid, limit)]).toEqual([
            uid,
            first.get(uid),
          ]);
        }
        orders++;
      }
      expect(orders).toBe(720);
      // The featured participants were read once for each conversation.
      expect(
        queryP_metered_readOnly.mock.calls.filter(
          ([name]) => name === "getSocialParticipants"
        ).length
      ).toBe(REQUESTERS.length + orders);
    }
  );

  test("a featured requester's reply leaves the kept row as everyone else sees it", async () => {
    const z = ++zid;
    const before = JSON.parse(await reply(z, undefined));
    const theirs = JSON.parse(await reply(z, 50));
    expect(theirs["2"]).toMatchObject({ priority: 1000, isSelf: true });
    const after = JSON.parse(await reply(z, undefined));
    expect(after).toEqual(before);
    expect(after["2"].priority).toBe(100);
    expect(after["2"]).not.toHaveProperty("isSelf");
    expect(Object.keys(after["2"])).toEqual([
      "priority",
      "pid",
      "xInfo",
      "votes",
      "bid",
    ]);
  });
});
