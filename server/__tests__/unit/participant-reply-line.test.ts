/**
 * Unit tests of the `participant_reply` log line the participant middleware
 * writes for a vote or a comment that nginx also copied to the read-only
 * shadow: the exact line for each way a person is found or created, nothing
 * without nginx's request id, and a logger that throws changes nothing about
 * what the middleware does.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { Response } from "express";
import type { RequestWithP } from "../../src/d";
import { ensureParticipant } from "../../src/auth/ensure-participant";
import logger from "../../src/utils/logger";
import { getConversationInfo } from "../../src/conversation";
import { createXidRecord, getXidRecord, xidExists } from "../../src/xids";
import { addParticipantAndMetadata } from "../../src/participant";
import { createAnonUser } from "../../src/auth/create-user";
import { getPidPromise } from "../../src/user";
import { getZinvite } from "../../src/utils/zinvite";
import { failJson } from "../../src/utils/fail";
import pg from "../../src/db/pg-query";

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../src/conversation", () => ({
  getConversationInfo: jest.fn(),
  getZidFromConversationId: jest.fn(async () => 1),
}));
jest.mock("../../src/xids", () => ({
  getXidRecord: jest.fn(),
  createXidRecord: jest.fn(),
  isXidAllowed: jest.fn(),
  xidExists: jest.fn(),
}));
jest.mock("../../src/participant", () => ({
  addParticipantAndMetadata: jest.fn(),
}));
jest.mock("../../src/auth/create-user", () => ({
  createAnonUser: jest.fn(),
}));
jest.mock("../../src/user", () => ({
  getPidPromise: jest.fn(),
}));
jest.mock("../../src/utils/zinvite", () => ({
  getZinvite: jest.fn(),
}));
jest.mock("../../src/utils/common", () => ({
  isDuplicateKey: jest.fn(() => false),
}));
jest.mock("../../src/utils/fail", () => ({
  failJson: jest.fn((res: { statusCode?: number }, status: number) => {
    res.statusCode = status;
  }),
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP_readOnly: jest.fn() },
}));
jest.mock("../../src/auth/xid-account", () => ({
  isXidAccountError: jest.fn(() => false),
  requireXidParticipantAccount: jest.fn(async () => undefined),
  respondToXidAccountError: jest.fn(),
}));
jest.mock("../../src/auth/anonymous-jwt", () => ({
  issueAnonymousJWT: jest.fn(() => "anonymous-token-value"),
}));
jest.mock("../../src/auth/xid-jwt", () => ({
  issueXidJWT: jest.fn(() => "xid-token-value"),
}));
jest.mock("../../src/auth/standard-user-jwt", () => ({
  issueStandardUserJWT: jest.fn(() => "standard-token-value"),
}));

const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const OWNER = 9;

// The mocks are called with whatever the middleware passes.
type AnyMock = jest.Mock<(...args: unknown[]) => unknown>;

const mocked = {
  getConversationInfo: getConversationInfo as unknown as AnyMock,
  getXidRecord: getXidRecord as unknown as AnyMock,
  createXidRecord: createXidRecord as unknown as AnyMock,
  xidExists: xidExists as unknown as AnyMock,
  addParticipantAndMetadata: addParticipantAndMetadata as unknown as AnyMock,
  createAnonUser: createAnonUser as unknown as AnyMock,
  getPidPromise: getPidPromise as unknown as AnyMock,
  getZinvite: getZinvite as unknown as AnyMock,
  failJson: failJson as unknown as AnyMock,
  queryP_readOnly: pg.queryP_readOnly as unknown as AnyMock,
  info: logger.info as unknown as AnyMock,
  warn: logger.warn as unknown as AnyMock,
  error: logger.error as unknown as AnyMock,
};

interface Built {
  req: RequestWithP;
  res: Response & { statusCode?: number };
}

function build(
  p: Record<string, unknown>,
  opts: {
    path?: string;
    requestId?: string | null;
    authorization?: string;
  } = {}
): Built {
  const headers: Record<string, string> = {};
  if (opts.requestId !== null) {
    headers["x-request-id"] = opts.requestId ?? REQUEST_ID;
  }
  if (opts.authorization) headers.authorization = opts.authorization;
  const req = {
    method: "POST",
    route: { path: opts.path ?? "/api/v3/votes" },
    headers,
    body: { conversation_id: "conv1" },
    p: { zid: 1, ...p },
  } as unknown as RequestWithP;
  const res = {} as Response & { statusCode?: number };
  return { req, res };
}

async function run(built: Built) {
  const next = jest.fn();
  await ensureParticipant({ createIfMissing: true, issueJWT: true })(
    built.req,
    built.res,
    next
  );
  return next;
}

function participantReplyCalls() {
  return [mocked.info, mocked.warn, mocked.error].flatMap((fn) =>
    fn.mock.calls
      .filter((call) => call[0] === "participant_reply")
      .map((call) => ({ level: fn, line: call[1] }))
  );
}

function onlyLine() {
  const calls = participantReplyCalls();
  expect(calls).toHaveLength(1);
  return calls[0];
}

/** A conversation that requires no xid, keeps no allow-list, and is not Treevite. */
function openConversation() {
  mocked.getConversationInfo.mockResolvedValue({
    use_xid_whitelist: false,
    xid_required: false,
    owner: OWNER,
  });
  mocked.queryP_readOnly.mockResolvedValue([
    { treevite_enabled: false, owner: OWNER },
  ]);
  mocked.getZinvite.mockResolvedValue("conv1");
}

/** Every path below, as a request and the database's answers. */
const paths: Record<string, () => Built> = {
  newAnonymous: () => {
    openConversation();
    mocked.createAnonUser.mockResolvedValue(501);
    mocked.getPidPromise.mockResolvedValue(-1);
    mocked.addParticipantAndMetadata.mockResolvedValue([{ pid: 7 }]);
    return build({});
  },
  foundByToken: () => {
    openConversation();
    return build(
      {
        uid: 502,
        pid: 3,
        anonymous_participant: true,
        jwt_conversation_id: "conv1",
      },
      { authorization: "Bearer anonymous-token-value" }
    );
  },
  xidBound: () => {
    openConversation();
    mocked.getXidRecord.mockResolvedValue([]);
    mocked.createAnonUser.mockResolvedValue(503);
    mocked.getPidPromise.mockResolvedValue(-1);
    mocked.addParticipantAndMetadata.mockResolvedValue([{ pid: 8 }]);
    mocked.xidExists.mockResolvedValue(false);
    mocked.createXidRecord.mockResolvedValue(undefined);
    return build({ xid: "external-person-1" });
  },
  xidFound: () => {
    openConversation();
    mocked.getXidRecord.mockResolvedValue([{ uid: 504 }]);
    mocked.getPidPromise.mockResolvedValue(4);
    return build({ xid: "external-person-2" });
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked.info.mockImplementation(() => undefined);
  mocked.warn.mockImplementation(() => undefined);
  mocked.error.mockImplementation(() => undefined);
});

describe("participant_reply line", () => {
  test("a new anonymous person: user and participant created, anonymous token issued", async () => {
    const next = await run(paths.newAnonymous());
    expect(next).toHaveBeenCalledWith();
    const { level, line } = onlyLine();
    expect(level).toBe(mocked.info);
    expect(line).toStrictEqual({
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: 1,
      node_identity: "none",
      node_token_scope: "none",
      node_new_user: true,
      node_new_participant: true,
      node_xid: "none",
      node_token: "anonymous",
    });
  });

  test("an existing participant found by its token: nothing created, no token issued", async () => {
    const next = await run(paths.foundByToken());
    expect(next).toHaveBeenCalledWith();
    expect(onlyLine().line).toStrictEqual({
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: 1,
      node_identity: "anonymous_token",
      node_token_scope: "this",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "none",
      node_token: "none",
    });
  });

  test("an external id bound: user, participant and binding written, xid token issued", async () => {
    const next = await run(paths.xidBound());
    expect(next).toHaveBeenCalledWith();
    expect(mocked.createXidRecord).toHaveBeenCalledTimes(1);
    expect(onlyLine().line).toStrictEqual({
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: 1,
      node_identity: "xid",
      node_token_scope: "none",
      node_new_user: true,
      node_new_participant: true,
      node_xid: "bound",
      node_token: "xid",
    });
  });

  test("an external id found: its binding and participant exist, xid token issued", async () => {
    const next = await run(paths.xidFound());
    expect(next).toHaveBeenCalledWith();
    expect(mocked.createAnonUser).not.toHaveBeenCalled();
    expect(onlyLine().line).toStrictEqual({
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: 1,
      node_identity: "xid",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "existing",
      node_token: "xid",
    });
  });

  test("the comments route is named as such", async () => {
    const built = paths.newAnonymous();
    (built.req as unknown as { route: { path: string } }).route.path =
      "/api/v3/comments";
    await run(built);
    expect(onlyLine().line).toMatchObject({ route: "POST /api/v3/comments" });
  });

  test("a refusal: the refusal is named, at warn, with what was decided before it", async () => {
    mocked.getConversationInfo.mockResolvedValue({
      use_xid_whitelist: false,
      xid_required: true,
      owner: OWNER,
    });
    const built = build({});
    const next = await run(built);
    expect(next).not.toHaveBeenCalled();
    expect(mocked.failJson).toHaveBeenCalledWith(
      built.res,
      403,
      "polis_err_xid_required"
    );
    const { level, line } = onlyLine();
    expect(level).toBe(mocked.warn);
    expect(line).toStrictEqual({
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: 1,
      node_identity: "none",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "none",
      node_token: "none",
      node_refusal: "xid_required",
    });
  });

  test.each(Object.keys(paths))(
    "%s: nothing is logged without nginx's request id, or with one in another form",
    async (name) => {
      for (const requestId of [null, REQUEST_ID.toUpperCase(), "abc"]) {
        jest.clearAllMocks();
        const built = paths[name]();
        if (requestId === null) {
          delete (built.req.headers as Record<string, unknown>)["x-request-id"];
        } else {
          (built.req.headers as Record<string, unknown>)["x-request-id"] =
            requestId;
        }
        const next = await run(built);
        expect(next).toHaveBeenCalledWith();
        expect(participantReplyCalls()).toHaveLength(0);
      }
    }
  );

  test("nothing is logged for another route that uses the middleware", async () => {
    const built = paths.newAnonymous();
    (built.req as unknown as { route: { path: string } }).route.path =
      "/api/v3/topicAgenda/selections";
    await run(built);
    expect(participantReplyCalls()).toHaveLength(0);
  });

  test.each(Object.keys(paths))(
    "%s: a logger that throws changes nothing about what the middleware does",
    async (name) => {
      const ok = paths[name]();
      const okNextCalls = [...(await run(ok)).mock.calls];
      const okCalls = {
        createAnonUser: mocked.createAnonUser.mock.calls.length,
        add: mocked.addParticipantAndMetadata.mock.calls.length,
        createXid: mocked.createXidRecord.mock.calls.length,
      };

      jest.clearAllMocks();
      for (const fn of [mocked.info, mocked.warn, mocked.error]) {
        fn.mockImplementation(() => {
          throw new Error("logger down");
        });
      }
      const bad = paths[name]();
      const badNext = await run(bad);
      // The line was attempted, and its logger threw.
      expect(mocked.info).toHaveBeenCalledWith(
        "participant_reply",
        expect.anything()
      );

      expect(okNextCalls).toStrictEqual([[]]);
      expect(badNext.mock.calls).toStrictEqual(okNextCalls);
      expect(bad.req.p).toStrictEqual(ok.req.p);
      expect(bad.res).toStrictEqual(ok.res);
      expect({
        createAnonUser: mocked.createAnonUser.mock.calls.length,
        add: mocked.addParticipantAndMetadata.mock.calls.length,
        createXid: mocked.createXidRecord.mock.calls.length,
      }).toStrictEqual(okCalls);
    }
  );

  test("a logger that throws on a refusal changes nothing about the refusal", async () => {
    mocked.getConversationInfo.mockResolvedValue({
      use_xid_whitelist: false,
      xid_required: true,
      owner: OWNER,
    });
    mocked.warn.mockImplementation(() => {
      throw new Error("logger down");
    });
    const built = build({});
    const next = await run(built);
    expect(next).not.toHaveBeenCalled();
    expect(mocked.failJson).toHaveBeenCalledTimes(1);
    expect(built.res.statusCode).toBe(403);
  });
});
