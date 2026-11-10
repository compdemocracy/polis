/**
 * POST /api/v3/votes writes one `vote_reply` line when nginx also copied the
 * vote to the read-only shadow service (the request carries nginx's
 * X-Request-Id): Node's status and, on a 200, the next statement it served,
 * so a comparison can join the copy's would-be answer to Node's answer by the
 * request id. The line never carries the vote, the participant or any text;
 * it is written after the reply, adds no database call, and changes no reply.
 * Without a well-formed request id there is no line at all.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
}));
jest.mock("../../src/utils/sqs", () => ({ sqsClient: { send: jest.fn() } }));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    query_readOnly: jest.fn(),
    queryP: jest.fn(),
    queryP_readOnly: jest.fn(),
  },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
// failJson answers synchronously and so sets the status, as Express's
// res.status() does; the handler's line reads it from there.
jest.mock("../../src/utils/fail", () => ({
  failJson: jest.fn((res: { statusCode?: number }, status: number) => {
    res.statusCode = status;
  }),
}));
jest.mock("../../src/server-helpers", () => ({
  addNoMoreCommentsRecord: jest.fn(),
  addStar: jest.fn(),
  doFamousQuery: jest.fn(),
  finishArray: jest.fn(),
  finishOne: jest.fn(),
  safeTimestampToMillis: jest.fn(() => 1700000000000),
  updateLastInteractionTimeForConversation: jest.fn(),
}));
jest.mock("../../src/nextComment", () => ({ getNextComment: jest.fn() }));
jest.mock("../../src/user", () => ({}));

import pg from "../../src/db/pg-query";
import logger from "../../src/utils/logger";
import { failJson } from "../../src/utils/fail";
import { addNoMoreCommentsRecord, finishOne } from "../../src/server-helpers";
import { getNextComment } from "../../src/nextComment";
import { handle_POST_votes } from "../../src/routes/votes";
import {
  WIRE_AGREE,
  WIRE_DISAGREE,
  WIRE_PASS,
} from "../../src/votes/convention";

const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const ZID = 7;
// Distinctive values that must never appear in the line.
const PID = 4242;
const UID = 9191;
const TXT = "a statement nobody may log";

type Next = Record<string, unknown> | null;

// The database as handle_POST_votes sees it: the conversation row, then the
// vote insert's callback. `insertError` makes the insert fail.
function database(options: {
  conversation?: Record<string, unknown>[];
  insertError?: unknown;
}) {
  (pg.queryP_readOnly as jest.Mock).mockResolvedValue(
    (options.conversation ?? [{ zid: ZID, is_active: true }]) as never
  );
  (pg.query as jest.Mock).mockImplementation(((
    _sql: string,
    _params: unknown[],
    callback: (err: unknown, result?: { rows: unknown[] }) => void
  ) => {
    if (options.insertError) callback(options.insertError);
    else callback(null, { rows: [{ created: "1700000000000" }] });
  }) as never);
}

async function vote(options: {
  headers?: Record<string, unknown>;
  next?: Next | Promise<Next>;
  nextError?: unknown;
  conversation?: Record<string, unknown>[];
  insertError?: unknown;
  vote?: number;
}) {
  database(options);
  if (options.nextError !== undefined) {
    (getNextComment as jest.Mock).mockRejectedValue(options.nextError as never);
  } else {
    (getNextComment as jest.Mock).mockResolvedValue(
      (options.next === undefined ? null : options.next) as never
    );
  }
  const req = {
    headers: options.headers ?? {},
    p: {
      zid: ZID,
      pid: PID,
      uid: UID,
      tid: 3,
      vote: options.vote ?? WIRE_AGREE,
      weight: 0,
      high_priority: false,
      lang: "en",
    },
  };
  const res = { status: jest.fn(), json: jest.fn() };
  await handle_POST_votes(req as any, res as any);
  return res;
}

const LEVELS = ["info", "warn", "error"] as const;

// Every `vote_reply` call, at whichever level it was written.
function replyLines(): {
  level: string;
  meta: Record<string, unknown>;
  order: number;
}[] {
  return LEVELS.flatMap((level) => {
    const mock = logger[level] as jest.Mock;
    return mock.mock.calls
      .map((call, i) => ({ call, order: mock.mock.invocationCallOrder[i] }))
      .filter(({ call }) => call[0] === "vote_reply")
      .map(({ call, order }) => ({
        level,
        meta: call[1] as Record<string, unknown>,
        order,
      }));
  });
}

function onlyLine(): { level: unknown; meta: Record<string, unknown> } {
  const lines = replyLines();
  expect(lines).toHaveLength(1);
  return { level: lines[0].level, meta: lines[0].meta };
}

function expectNothingPrivate(meta: Record<string, unknown>) {
  for (const key of ["vote", "pid", "uid", "txt", "xid", "weight", "tid"]) {
    expect(meta).not.toHaveProperty(key);
  }
  const text = JSON.stringify(meta);
  expect(text).not.toContain(String(PID));
  expect(text).not.toContain(String(UID));
  expect(text).not.toContain(TXT);
}

const header = { "x-request-id": REQUEST_ID };
const statement = {
  tid: 5,
  txt: TXT,
  created: "1690000000000",
  is_seed: false,
  is_meta: false,
  lang: "en",
  pid: PID,
  randomN: 0.25,
  remaining: 3,
  total: 10,
  translations: [],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("vote_reply", () => {
  test("a 200 with a next statement: its tid and counts, at info", async () => {
    await vote({ headers: header, next: { ...statement } });
    const { level, meta } = onlyLine();
    expect(level).toBe("info");
    expect(meta).toEqual({
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: ZID,
      node_status: 200,
      node_next: "statement",
      node_next_tid: 5,
      node_remaining: 3,
      node_total: 10,
    });
    // The key order is the line's order.
    expect(Object.keys(meta)).toEqual([
      "listener",
      "route",
      "request_id",
      "zid",
      "node_status",
      "node_next",
      "node_next_tid",
      "node_remaining",
      "node_total",
    ]);
    expectNothingPrivate(meta);
  });

  test("a 200 with nothing left: none, and no tid or counts", async () => {
    await vote({ headers: header, next: null });
    const { level, meta } = onlyLine();
    expect(level).toBe("info");
    expect(meta).toEqual({
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: ZID,
      node_status: 200,
      node_next: "none",
    });
    expect(addNoMoreCommentsRecord).toHaveBeenCalledTimes(1);
    expectNothingPrivate(meta);
  });

  test("a 200 with a topic-agenda pick: topical, its tid and no counts", async () => {
    // getNextTopicalComment's shape: zid, tid, txt; no remaining or total.
    await vote({ headers: header, next: { zid: ZID, tid: 9, txt: TXT } });
    const { meta } = onlyLine();
    expect(meta).toEqual({
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: ZID,
      node_status: 200,
      node_next: "topical",
      node_next_tid: 9,
    });
    expectNothingPrivate(meta);
  });

  test("the agree, disagree and pass votes give the same line", async () => {
    const metas = [];
    for (const v of [WIRE_AGREE, WIRE_PASS, WIRE_DISAGREE]) {
      jest.clearAllMocks();
      await vote({ headers: header, next: { ...statement }, vote: v });
      metas.push(onlyLine().meta);
    }
    expect(metas[1]).toEqual(metas[0]);
    expect(metas[2]).toEqual(metas[0]);
  });

  const insertDuplicate = { code: "23505", sqlState: "23505" };
  test.each([
    [
      "a duplicate vote",
      { insertError: insertDuplicate },
      406,
      "polis_err_vote_duplicate",
      "warn",
    ],
    [
      "a closed conversation",
      { conversation: [{ zid: ZID, is_active: false }] },
      403,
      "polis_err_conversation_is_closed",
      "warn",
    ],
    [
      "an unknown conversation",
      { conversation: [] },
      500,
      "polis_err_vote",
      "error",
    ],
    [
      "a failed insert",
      { insertError: new Error("connection lost") },
      500,
      "polis_err_vote",
      "error",
    ],
    [
      "a next-statement failure after the vote was stored",
      { nextError: new Error("selection failed") },
      500,
      "polis_err_vote",
      "error",
    ],
    [
      "polis_err_post_votes_social_needed",
      { nextError: "polis_err_post_votes_social_needed" },
      403,
      "polis_err_post_votes_social_needed",
      "warn",
    ],
    [
      "polis_err_xid_not_allowed",
      { nextError: "polis_err_xid_not_allowed" },
      403,
      "polis_err_xid_not_allowed",
      "warn",
    ],
    [
      "polis_err_vote_anonymous_user_creation",
      { nextError: "polis_err_vote_anonymous_user_creation" },
      500,
      "polis_err_vote_anonymous_user_creation",
      "error",
    ],
  ])(
    "%s: the mapped status, no next statement, the http_request level",
    async (_name, setup, status, code, level) => {
      const res = await vote({ headers: header, ...setup });
      expect(failJson).toHaveBeenCalledTimes(1);
      expect((failJson as jest.Mock).mock.calls[0].slice(0, 3)).toEqual([
        res,
        status,
        code,
      ]);
      expect(finishOne).not.toHaveBeenCalled();
      const line = onlyLine();
      expect(line.level).toBe(level);
      expect(line.meta).toEqual({
        listener: "shadow",
        route: "POST /api/v3/votes",
        request_id: REQUEST_ID,
        zid: ZID,
        node_status: status,
      });
      expectNothingPrivate(line.meta);
    }
  );

  test.each([
    ["no header", {}],
    ["an empty header", { "x-request-id": "" }],
    ["upper-case hex", { "x-request-id": REQUEST_ID.toUpperCase() }],
    ["31 characters", { "x-request-id": REQUEST_ID.slice(1) }],
    ["33 characters", { "x-request-id": REQUEST_ID + "0" }],
    ["not hex", { "x-request-id": "g".repeat(32) }],
    ["a line break", { "x-request-id": REQUEST_ID + "\n" }],
    ["a repeated header", { "x-request-id": [REQUEST_ID, REQUEST_ID] }],
  ])("%s: no line", async (_name, headers) => {
    await vote({ headers, next: { ...statement } });
    expect(replyLines()).toHaveLength(0);
    jest.clearAllMocks();
    await vote({ headers, nextError: new Error("selection failed") });
    expect(replyLines()).toHaveLength(0);
  });

  test("the reply and the database calls are the same with and without the line", async () => {
    const observe = async (headers: Record<string, unknown>, next: Next) => {
      jest.clearAllMocks();
      const res = await vote({ headers, next });
      return {
        res,
        finishOne: (finishOne as jest.Mock).mock.calls.map((c) => c[1]),
        failJson: (failJson as jest.Mock).mock.calls.map((c) => c.slice(1)),
        query: (pg.query as jest.Mock).mock.calls.map((c) => c.slice(0, 2)),
        readOnly: (pg.queryP_readOnly as jest.Mock).mock.calls,
        other: [
          (pg.queryP as jest.Mock).mock.calls.length,
          (pg.query_readOnly as jest.Mock).mock.calls.length,
        ],
        next: (getNextComment as jest.Mock).mock.calls,
      };
    };
    for (const next of [{ ...statement }, null, { zid: ZID, tid: 9 }]) {
      const without = await observe({}, next);
      const withId = await observe(header, next);
      expect(replyLines()).toHaveLength(1);
      expect(withId.finishOne).toEqual(without.finishOne);
      expect(withId.finishOne).toHaveLength(1);
      expect(withId.failJson).toEqual(without.failJson);
      expect(withId.query).toEqual(without.query);
      expect(withId.readOnly).toEqual(without.readOnly);
      expect(withId.other).toEqual(without.other);
      expect(withId.next).toEqual(without.next);
      expect(withId.res.status).not.toHaveBeenCalled();
    }
  });

  test("the line is written after the reply is handed to Express", async () => {
    await vote({ headers: header, next: { ...statement } });
    const replied = (finishOne as jest.Mock).mock.invocationCallOrder[0];
    expect(onlyLine()).toBeDefined();
    expect(replyLines()[0].order).toBeGreaterThan(replied);
    // On a failure, after failJson.
    jest.clearAllMocks();
    await vote({
      headers: header,
      conversation: [{ zid: ZID, is_active: false }],
    });
    const failed = (failJson as jest.Mock).mock.invocationCallOrder[0];
    expect(replyLines()[0].order).toBeGreaterThan(failed);
  });

  test("a logger that throws changes no reply and never answers twice", async () => {
    for (const level of LEVELS) {
      (logger[level] as jest.Mock).mockImplementation((message: unknown) => {
        if (message === "vote_reply") throw new Error("log transport closed");
      });
    }
    const closed = await vote({
      headers: header,
      conversation: [{ zid: ZID, is_active: false }],
    });
    expect(failJson).toHaveBeenCalledTimes(1);
    expect((failJson as jest.Mock).mock.calls[0][1]).toBe(403);
    expect(closed.status).not.toHaveBeenCalled();
    jest.clearAllMocks();
    database({});
    (getNextComment as jest.Mock).mockResolvedValue({ ...statement } as never);
    const req = {
      headers: header,
      p: { zid: ZID, pid: PID, uid: UID, tid: 3, vote: WIRE_AGREE, lang: "en" },
    };
    await expect(
      handle_POST_votes(req as any, { status: jest.fn() } as any)
    ).resolves.toBeUndefined();
    expect(finishOne).toHaveBeenCalledTimes(1);
    expect(failJson).not.toHaveBeenCalled();
    for (const level of LEVELS) (logger[level] as jest.Mock).mockReset();
  });
});
