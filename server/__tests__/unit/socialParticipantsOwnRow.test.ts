import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * getSocialParticipants (src/participant.ts): the participants the opinion map
 * shows by name or picture, for one requester.
 *
 * The featured participants (moderators' pins, authors of featured comments,
 * participants with an external id) are kept 30 seconds and are the same for
 * every requester. The requester's own row is decided on every request and is
 * never kept.
 *
 * The database is a stand-in here: it answers the two statements by their
 * metric name and counts them. The statements themselves run against a real
 * database in __tests__/integration/votes-famous-own-row.test.ts.
 */

type Row = Record<string, unknown>;

const queryP_metered_readOnly =
  jest.fn<(name: string, sql: string, params: unknown[]) => Promise<Row[]>>();

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP_metered_readOnly },
}));
jest.mock("../../src/db/sql", () => ({
  __esModule: true,
  sql_participants_extended: {},
}));
jest.mock("../../src/session", () => ({
  __esModule: true,
  encrypt: jest.fn(),
}));
jest.mock("../../src/user", () => ({
  __esModule: true,
  getPidPromise: jest.fn(),
}));
jest.mock("../../src/config", () => ({ __esModule: true, default: {} }));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { getSocialParticipants } from "../../src/participant";

const COLUMNS = [
  "priority",
  "x_profile_image_url",
  "xid",
  "x_name",
  "x_email",
  "pid",
];

/** A row as the featured statement returns it: the account last. */
function featuredRow(priority: number, pid: number, uid: number): Row {
  return {
    priority,
    x_profile_image_url: `https://example.invalid/${pid}.png`,
    xid: `id-${pid}`,
    x_name: `Name ${pid}`,
    x_email: null,
    pid,
    uid,
  };
}

/** A row as the own-row statement returns it. */
function ownRow(pid: number): Row {
  return {
    priority: 1000,
    x_profile_image_url: null,
    xid: null,
    x_name: null,
    x_email: null,
    pid,
  };
}

// The featured ranking of the conversation under test: a pin, a featured
// author, two participants with an external id. Among equals the smaller
// account comes first; the accounts are not in participant-number order.
function ranking(): Row[] {
  return [
    featuredRow(999, 4, 40),
    featuredRow(900, 0, 10),
    featuredRow(100, 2, 50),
    featuredRow(100, 3, 30),
  ];
}

// Participants of the conversation with at least one vote, by account.
const VOTERS: Record<number, number> = { 70: 7, 71: 8, 10: 0, 50: 2 };

let statements: Array<{ name: string; sql: string; params: unknown[] }>;
let zid = 880000;

function count(name: string): number {
  return statements.filter((s) => s.name === name).length;
}

function summary(rows: Row[]): Array<[number, number]> {
  return rows
    .map((r) => [r.pid as number, r.priority as number] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

beforeEach(() => {
  // A conversation of its own for each test: nothing kept by another test.
  zid++;
  statements = [];
  queryP_metered_readOnly.mockReset();
  queryP_metered_readOnly.mockImplementation(async (name, sql, params) => {
    statements.push({ name, sql, params });
    if (name === "getSocialParticipants") {
      const limit = params[1] as number;
      return ranking().slice(0, limit);
    }
    if (name === "getOwnParticipantRows") {
      const pid = VOTERS[params[1] as number];
      return pid === undefined ? [] : [ownRow(pid)];
    }
    throw new Error(`unexpected statement ${name}`);
  });
});

describe("the requester's own row is decided for each request", () => {
  test("the first requester gets their own row and the featured participants", async () => {
    const rows = await getSocialParticipants(zid, 70, 30, 0, 5, []);
    expect(summary(rows)).toEqual([
      [0, 900],
      [2, 100],
      [3, 100],
      [4, 999],
      [7, 1000],
    ]);
    // The account never reaches a reply, and every row keeps its columns in
    // the statement's order.
    for (const row of rows) expect(Object.keys(row)).toEqual(COLUMNS);
  });

  test("a second requester within the 30 seconds gets their own row, not the first's", async () => {
    await getSocialParticipants(zid, 70, 30, 0, 5, []);
    const second = await getSocialParticipants(zid, 71, 30, 0, 5, []);
    expect(summary(second)).toEqual([
      [0, 900],
      [2, 100],
      [3, 100],
      [4, 999],
      [8, 1000],
    ]);
    // The featured participants were read once; each own row for its request.
    expect(count("getSocialParticipants")).toBe(1);
    expect(count("getOwnParticipantRows")).toBe(2);
  });

  test("a requester without an account within the 30 seconds gets no row of their own", async () => {
    await getSocialParticipants(zid, 70, 30, 0, 5, []);
    const rows = await getSocialParticipants(zid, undefined, 30, 0, 5, []);
    expect(summary(rows)).toEqual([
      [0, 900],
      [2, 100],
      [3, 100],
      [4, 999],
    ]);
    expect(rows.some((r) => r.priority === 1000)).toBe(false);
    // Nothing is read for a requester without an account.
    expect(count("getOwnParticipantRows")).toBe(1);
  });

  test("an account that is no participant with a vote gets no row of its own", async () => {
    const rows = await getSocialParticipants(zid, 999, 30, 0, 5, []);
    expect(summary(rows)).toEqual([
      [0, 900],
      [2, 100],
      [3, 100],
      [4, 999],
    ]);
    // Nor does it take anyone's place when the featured participants fill
    // the limit.
    const full = await getSocialParticipants(zid, 999, 4, 0, 5, []);
    expect(summary(full)).toEqual([
      [0, 900],
      [2, 100],
      [3, 100],
      [4, 999],
    ]);
  });

  test("a mark put on one reply's own row is in nobody else's reply", async () => {
    // doFamousQuery marks and fills the rows it is given, in place.
    const first = await getSocialParticipants(zid, 70, 30, 0, 5, []);
    for (const row of first) {
      if (row.priority === 1000) row.isSelf = true;
      row.votes = "a";
      row.bid = 1;
    }
    const anonymous = await getSocialParticipants(zid, undefined, 30, 0, 5, []);
    expect(anonymous.some((r) => r.isSelf || r.priority === 1000)).toBe(false);
    const second = await getSocialParticipants(zid, 71, 30, 0, 5, []);
    expect(second.filter((r) => r.isSelf)).toEqual([]);
    expect(second.find((r) => r.pid === 8)).toEqual(ownRow(8));
    expect(second.some((r) => r.pid === 7)).toBe(false);
  });
});

describe("the own row and the limit", () => {
  test("the requester takes the first place; the last of the ranking gives up its own", async () => {
    // Four places, four featured participants: the lowest priority and, of
    // those, the greatest account (participant 2) gives up its place.
    const rows = await getSocialParticipants(zid, 70, 4, 0, 5, []);
    expect(summary(rows)).toEqual([
      [0, 900],
      [3, 100],
      [4, 999],
      [7, 1000],
    ]);
    // One place more than the featured participants take: nobody gives up
    // theirs.
    const roomy = await getSocialParticipants(zid, 70, 5, 0, 5, []);
    expect(summary(roomy)).toEqual([
      [0, 900],
      [2, 100],
      [3, 100],
      [4, 999],
      [7, 1000],
    ]);
    // The kept rows are unchanged: the next requester sees all four.
    const anonymous = await getSocialParticipants(zid, undefined, 4, 0, 5, []);
    expect(summary(anonymous)).toEqual([
      [0, 900],
      [2, 100],
      [3, 100],
      [4, 999],
    ]);
  });

  test("a featured participant with two external ids is one person when the places are counted", async () => {
    // The statement limits people, not rows: three people fill four rows
    // when one of them holds two external ids under the conversation's
    // account.
    queryP_metered_readOnly.mockImplementation(async (name, sql, params) => {
      statements.push({ name, sql, params });
      if (name === "getSocialParticipants") {
        return [
          featuredRow(999, 4, 40),
          featuredRow(100, 2, 50),
          { ...featuredRow(100, 2, 50), xid: "id-2-other" },
          featuredRow(100, 3, 30),
        ];
      }
      return [ownRow(VOTERS[params[1] as number])];
    });
    // Four places, three people featured: the requester takes the fourth
    // and nobody gives up theirs.
    expect(summary(await getSocialParticipants(zid, 70, 4, 0, 5, []))).toEqual([
      [2, 100],
      [2, 100],
      [3, 100],
      [4, 999],
      [7, 1000],
    ]);
    // Three places: the last of the ranking (account 50, both its rows)
    // gives up its place.
    expect(summary(await getSocialParticipants(zid, 70, 3, 0, 5, []))).toEqual([
      [3, 100],
      [4, 999],
      [7, 1000],
    ]);
  });

  test("a limit of one is the requester alone, and a limit of zero is nobody", async () => {
    expect(summary(await getSocialParticipants(zid, 70, 1, 0, 5, []))).toEqual([
      [7, 1000],
    ]);
    expect(await getSocialParticipants(zid, 70, 0, 0, 5, [])).toEqual([]);
    // No own row is read at a limit of zero.
    expect(count("getOwnParticipantRows")).toBe(1);
  });

  test("the limit, the conversation and the tick each keep their own rows", async () => {
    await getSocialParticipants(zid, undefined, 4, 0, 5, []);
    await getSocialParticipants(zid, undefined, 4, 0, 5, []);
    expect(count("getSocialParticipants")).toBe(1);
    await getSocialParticipants(zid, undefined, 3, 0, 5, []);
    await getSocialParticipants(zid, undefined, 4, 0, 6, []);
    await getSocialParticipants(zid + 500000, undefined, 4, 0, 5, []);
    expect(count("getSocialParticipants")).toBe(4);
  });
});

describe("the kept rows and their 30 seconds", () => {
  test("the featured participants are read again once their 30 seconds have passed", async () => {
    let now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await getSocialParticipants(zid, 70, 4, 0, 5, []);
      now += 30_000;
      await getSocialParticipants(zid, 71, 4, 0, 5, []);
      expect(count("getSocialParticipants")).toBe(1);
      now += 1;
      await getSocialParticipants(zid, 71, 4, 0, 5, []);
      expect(count("getSocialParticipants")).toBe(2);
      // An own row is read for every one of the three requests.
      expect(count("getOwnParticipantRows")).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("a requester who is one of the featured participants", () => {
  test("gets that row as their own, once, and nobody gives up a place", async () => {
    // Account 10 is the featured author (participant 0).
    const rows = await getSocialParticipants(zid, 10, 4, 0, 5, []);
    expect(summary(rows)).toEqual([
      [0, 1000],
      [2, 100],
      [3, 100],
      [4, 999],
    ]);
    // Their columns are the kept row's, and nothing is read for them.
    const own = rows.find((r) => r.pid === 0);
    expect(own).toEqual({
      ...featuredRow(900, 0, 10),
      priority: 1000,
      uid: undefined,
    });
    expect(Object.keys(own)).toEqual(COLUMNS);
    expect(count("getOwnParticipantRows")).toBe(0);
  });

  test("is featured at their own priority for everyone else", async () => {
    await getSocialParticipants(zid, 10, 4, 0, 5, []);
    const anonymous = await getSocialParticipants(zid, undefined, 4, 0, 5, []);
    expect(summary(anonymous)).toEqual([
      [0, 900],
      [2, 100],
      [3, 100],
      [4, 999],
    ]);
    const other = await getSocialParticipants(zid, 50, 4, 0, 5, []);
    expect(summary(other)).toEqual([
      [0, 900],
      [2, 1000],
      [3, 100],
      [4, 999],
    ]);
  });

  test("their own row starts without the votes and cluster of an earlier reply", async () => {
    // An earlier reply nested the external id and put votes and a cluster on
    // the kept row, in place.
    const first = await getSocialParticipants(zid, undefined, 4, 0, 5, []);
    for (const row of first) {
      row.xInfo = {
        x_profile_image_url: row.x_profile_image_url,
        x_name: row.x_name,
      };
      delete row.x_profile_image_url;
      delete row.xid;
      delete row.x_name;
      delete row.x_email;
      row.votes = "ad";
      row.bid = 3;
    }
    const rows = await getSocialParticipants(zid, 10, 4, 0, 5, []);
    const own = rows.find((r) => r.pid === 0);
    // The keys a first reply would have at this point, in its order, so the
    // mark, the votes and the cluster follow as they do for any own row.
    expect(Object.keys(own)).toEqual(["priority", "pid", "xInfo"]);
    expect(own.priority).toBe(1000);
    // The kept row keeps its own priority, votes and cluster.
    const kept = (
      await getSocialParticipants(zid, undefined, 4, 0, 5, [])
    ).find((r) => r.pid === 0);
    expect(kept).toMatchObject({ priority: 900, votes: "ad", bid: 3 });
  });

  test("beyond the limit, their own row is read for them and takes the first place", async () => {
    // Two places: the pin and the featured author. Account 50 is featured
    // further down the ranking.
    const rows = await getSocialParticipants(zid, 50, 2, 0, 5, []);
    expect(summary(rows)).toEqual([
      [2, 1000],
      [4, 999],
    ]);
    expect(count("getOwnParticipantRows")).toBe(1);
  });
});

describe("the two statements", () => {
  test("the featured statement does not know the requester", async () => {
    await getSocialParticipants(zid, 70, 30, 0, 5, [10]);
    const featured = statements.find((s) => s.name === "getSocialParticipants");
    expect(featured.params).toEqual([zid, 30, 0]);
    expect(featured.sql).not.toMatch(/self|1000|\$4/);
    expect(featured.sql).toContain(
      "from ( select * from authors union select * from xid_ptpts ) as prioritized_ptpts"
    );
    expect(featured.sql).toContain("limit ($2)");
    expect(featured.sql).toContain("where p.mod >= ($3)");
  });

  test("the own-row statement is one account's", async () => {
    await getSocialParticipants(zid, 70, 30, 0, 5, []);
    const own = statements.find((s) => s.name === "getOwnParticipantRows");
    expect(own.params).toEqual([zid, 70]);
    expect(own.sql).toContain("where zid = ($1) and uid = ($2) and EXISTS");
    expect(own.sql).toContain("1000 as priority");
    // External ids only under the conversation's account, and only with a
    // picture, as in the featured statement.
    expect(own.sql).toContain(
      "from xids where uid = ($2) and owner in (select org_id from conversations where zid = ($1)) and x_profile_image_url is not null"
    );
  });
});
