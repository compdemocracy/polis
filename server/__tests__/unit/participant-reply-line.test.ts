/**
 * Unit tests of the `participant_reply` log line the participant middleware
 * writes for a vote or a comment that nginx also copied to the read-only
 * shadow: the exact line for each way a person is found or created, each
 * refusal and error, the lookup and insert races, each token scope and kind,
 * nothing without nginx's request id, and a logger that throws changes
 * nothing about what the middleware does.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { Response } from "express";
import type { RequestWithP } from "../../src/d";
import { ensureParticipant } from "../../src/auth/ensure-participant";
import * as xidAccount from "../../src/auth/xid-account";
import logger from "../../src/utils/logger";
import {
  getConversationInfo,
  getZidFromConversationId,
} from "../../src/conversation";
import {
  createXidRecord,
  getXidRecord,
  isXidAllowed,
  xidExists,
} from "../../src/xids";
import { addParticipantAndMetadata } from "../../src/participant";
import { createAnonUser } from "../../src/auth/create-user";
import { getPidPromise } from "../../src/user";
import { getZinvite } from "../../src/utils/zinvite";
import { failJson } from "../../src/utils/fail";
import { isDuplicateKey, isPolisDev } from "../../src/utils/common";
import { issueAnonymousJWT } from "../../src/auth/anonymous-jwt";
import { issueXidJWT } from "../../src/auth/xid-jwt";
import { issueStandardUserJWT } from "../../src/auth/standard-user-jwt";
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
  isPolisDev: jest.fn(() => false),
}));
jest.mock("../../src/utils/fail", () => ({
  failJson: jest.fn((res: { statusCode?: number }, status: number) => {
    res.statusCode = status;
  }),
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP_readOnly: jest.fn(), queryP: jest.fn() },
}));
// The real account check (below) counts its refusals here.
jest.mock("../../src/utils/metered", () => ({ addInRamMetric: jest.fn() }));
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
  queryP: pg.queryP as unknown as AnyMock,
  getZidFromConversationId: getZidFromConversationId as unknown as AnyMock,
  isXidAllowed: isXidAllowed as unknown as AnyMock,
  isDuplicateKey: isDuplicateKey as unknown as AnyMock,
  isPolisDev: isPolisDev as unknown as AnyMock,
  issueAnonymousJWT: issueAnonymousJWT as unknown as AnyMock,
  issueXidJWT: issueXidJWT as unknown as AnyMock,
  issueStandardUserJWT: issueStandardUserJWT as unknown as AnyMock,
  isXidAccountError: xidAccount.isXidAccountError as unknown as AnyMock,
  requireXidParticipantAccount:
    xidAccount.requireXidParticipantAccount as unknown as AnyMock,
  respondToXidAccountError:
    xidAccount.respondToXidAccountError as unknown as AnyMock,
  info: logger.info as unknown as AnyMock,
  warn: logger.warn as unknown as AnyMock,
  error: logger.error as unknown as AnyMock,
};

// The account check as it is, so its 403 and its 500 can be told apart. Its
// own database read is the mocked pg.queryP.
const actualXidAccount = jest.requireActual<typeof xidAccount>(
  "../../src/auth/xid-account"
);

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

/**
 * Every mock back to its default: the tests below change answers for one
 * request (a rejection, a value for one call), and none may reach the next.
 */
function restoreDefaults() {
  jest.resetAllMocks();
  mocked.info.mockImplementation(() => undefined);
  mocked.warn.mockImplementation(() => undefined);
  mocked.error.mockImplementation(() => undefined);
  mocked.failJson.mockImplementation((res: unknown, status: unknown) => {
    (res as { statusCode?: number }).statusCode = status as number;
  });
  mocked.getZidFromConversationId.mockResolvedValue(1);
  mocked.isDuplicateKey.mockReturnValue(false);
  mocked.isPolisDev.mockReturnValue(false);
  mocked.issueAnonymousJWT.mockReturnValue("anonymous-token-value");
  mocked.issueXidJWT.mockReturnValue("xid-token-value");
  mocked.issueStandardUserJWT.mockReturnValue("standard-token-value");
  mocked.isXidAccountError.mockImplementation(
    actualXidAccount.isXidAccountError
  );
  mocked.requireXidParticipantAccount.mockResolvedValue(undefined);
  mocked.respondToXidAccountError.mockImplementation(
    actualXidAccount.respondToXidAccountError as unknown as (
      ...args: unknown[]
    ) => unknown
  );
}

beforeEach(() => {
  restoreDefaults();
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

/** A response the real account-error responder can answer on. */
function answerable(built: Built): Built {
  const res: {
    statusCode?: number;
    body?: unknown;
    status?: (code: number) => unknown;
    json?: (body: unknown) => unknown;
  } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  built.res = res as unknown as Built["res"];
  return built;
}

function answer(built: Built) {
  const res = built.res as unknown as { statusCode?: number; body?: unknown };
  return { statusCode: res.statusCode, body: res.body };
}

/** The fields every line below carries. */
const LINE = {
  listener: "shadow",
  route: "POST /api/v3/votes",
  request_id: REQUEST_ID,
  zid: 1,
};

interface ReplyCase {
  setup: () => Built;
  /** What the request is answered: a status, or what next() was called with. */
  answer: { status: number } | { next: "ok" } | { next: string };
  level: "info" | "warn" | "error";
  line: Record<string, unknown>;
}

const OTHER_CONVERSATION_TOKEN = { jwt_conversation_id: "other" };

/** A token issued for another conversation (zid 2). */
function fromOtherConversation(built: Built, p: Record<string, unknown>) {
  Object.assign(built.req.p, p, OTHER_CONVERSATION_TOKEN);
  (built.req.headers as Record<string, string>).authorization =
    "Bearer sample-token";
  mocked.getZidFromConversationId.mockResolvedValue(2);
  return built;
}

/** The account check runs for real; its database read answers `read`. */
function realAccountCheck(read: () => Promise<unknown>) {
  mocked.requireXidParticipantAccount.mockImplementation(
    actualXidAccount.requireXidParticipantAccount as unknown as (
      ...args: unknown[]
    ) => unknown
  );
  mocked.queryP.mockImplementation(read);
}

const PRIVILEGED_ACCOUNT = {
  is_owner: false,
  owns_conversation: true,
  site_moderator: false,
  oidc_mapped: false,
};

const cases: Record<string, ReplyCase> = {
  xidNotAllowed: {
    setup: () => {
      const built = paths.xidBound();
      mocked.getConversationInfo.mockResolvedValue({
        use_xid_whitelist: true,
        owner: OWNER,
      });
      mocked.isXidAllowed.mockResolvedValue(false);
      return built;
    },
    answer: { status: 403 },
    level: "warn",
    line: {
      node_identity: "xid",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "none",
      node_token: "none",
      node_refusal: "xid_not_allowed",
    },
  },
  treevite: {
    setup: () => {
      const built = paths.newAnonymous();
      mocked.queryP_readOnly.mockResolvedValue([
        { treevite_enabled: true, owner: OWNER },
      ]);
      return built;
    },
    answer: { status: 401 },
    level: "warn",
    line: {
      node_identity: "none",
      node_token_scope: "none",
      node_new_user: true,
      node_new_participant: false,
      node_xid: "none",
      node_token: "none",
      node_refusal: "treevite",
    },
  },
  accountRefused: {
    setup: () => {
      const built = paths.xidFound();
      realAccountCheck(async () => [PRIVILEGED_ACCOUNT]);
      return built;
    },
    answer: { status: 403 },
    level: "warn",
    line: {
      node_identity: "xid",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "existing",
      node_token: "none",
      node_refusal: "xid_account",
    },
  },
  accountCheckFailed: {
    setup: () => {
      const built = paths.xidFound();
      realAccountCheck(async () => {
        throw new Error("sentinel database unavailable");
      });
      return built;
    },
    answer: { status: 500 },
    level: "error",
    line: {
      node_identity: "xid",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "existing",
      node_token: "none",
      node_refusal: "error",
    },
  },
  missingConversation: {
    setup: () => build({ zid: undefined }),
    answer: { next: "polis_err_missing_zid" },
    level: "error",
    // No conversation, and the token's scope was never decided: both left out.
    line: {
      zid: undefined,
      node_identity: "none",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "none",
      node_token: "none",
      node_refusal: "error",
    },
  },
  createUserFailure: {
    setup: () => {
      const built = paths.newAnonymous();
      mocked.createAnonUser.mockRejectedValue(new Error("sentinel failure"));
      return built;
    },
    answer: { next: "polis_err_participant_creation" },
    level: "error",
    line: {
      node_identity: "none",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "none",
      node_token: "none",
      node_refusal: "error",
    },
  },
  createParticipantFailure: {
    setup: () => {
      const built = paths.newAnonymous();
      mocked.addParticipantAndMetadata.mockRejectedValue(
        new Error("sentinel failure")
      );
      return built;
    },
    answer: { next: "polis_err_participant_creation" },
    level: "error",
    line: {
      node_identity: "none",
      node_token_scope: "none",
      node_new_user: true,
      node_new_participant: false,
      node_xid: "none",
      node_token: "none",
      node_refusal: "error",
    },
  },
  bindingFailure: {
    setup: () => {
      const built = paths.xidBound();
      mocked.createXidRecord.mockRejectedValue(new Error("sentinel failure"));
      return built;
    },
    answer: { next: "polis_err_participant_creation" },
    level: "error",
    line: {
      node_identity: "xid",
      node_token_scope: "none",
      node_new_user: true,
      node_new_participant: true,
      node_xid: "none",
      node_token: "none",
      node_refusal: "error",
    },
  },
  // The first xid lookup finds nothing, a concurrent request binds the xid,
  // and the second lookup finds that binding: no users row is inserted here.
  xidLookupRace: {
    setup: () => {
      const built = paths.xidBound();
      mocked.getXidRecord
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ uid: 503 }]);
      mocked.xidExists.mockResolvedValue(true);
      return built;
    },
    answer: { next: "ok" },
    level: "info",
    line: {
      node_identity: "xid",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: true,
      node_xid: "existing",
      node_token: "xid",
    },
  },
  // The participant insert collides with a concurrent one, and the retry
  // reads the other request's row: no participant row is inserted here.
  participantInsertRace: {
    setup: () => {
      const built = paths.xidFound();
      mocked.getPidPromise.mockResolvedValueOnce(-1).mockResolvedValue(4);
      mocked.addParticipantAndMetadata.mockRejectedValue({ code: "23505" });
      mocked.isDuplicateKey.mockReturnValue(true);
      return built;
    },
    answer: { next: "ok" },
    level: "info",
    line: {
      node_identity: "xid",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: false,
      node_xid: "existing",
      node_token: "xid",
    },
  },
  tokenSigningFailure: {
    setup: () => {
      const built = paths.newAnonymous();
      mocked.issueAnonymousJWT.mockImplementation(() => {
        throw new Error("sentinel failure");
      });
      return built;
    },
    answer: { next: "ok" },
    level: "info",
    line: {
      node_identity: "none",
      node_token_scope: "none",
      node_new_user: true,
      node_new_participant: true,
      node_xid: "none",
      node_token: "none",
    },
  },
  anonymousTokenFromOtherConversation: {
    setup: () =>
      fromOtherConversation(paths.newAnonymous(), {
        uid: 502,
        pid: 3,
        anonymous_participant: true,
      }),
    answer: { next: "ok" },
    level: "info",
    line: {
      node_identity: "anonymous_token",
      node_token_scope: "other",
      node_new_user: true,
      node_new_participant: true,
      node_xid: "none",
      node_token: "anonymous",
    },
  },
  xidTokenFromOtherConversation: {
    setup: () =>
      fromOtherConversation(paths.xidBound(), {
        uid: 502,
        pid: 3,
        xid_participant: true,
        jwt_xid: "external-person-1",
      }),
    answer: { next: "ok" },
    level: "info",
    line: {
      node_identity: "xid_token",
      node_token_scope: "other",
      node_new_user: true,
      node_new_participant: true,
      node_xid: "bound",
      node_token: "xid",
    },
  },
  standardUserTokenFromOtherConversation: {
    setup: () =>
      fromOtherConversation(paths.newAnonymous(), {
        uid: 502,
        pid: 3,
        standard_user_participant: true,
        oidc_sub: "sample-subject",
      }),
    answer: { next: "ok" },
    level: "info",
    line: {
      node_identity: "standard_user_token",
      node_token_scope: "other",
      node_new_user: false,
      node_new_participant: true,
      node_xid: "none",
      node_token: "standard_user",
    },
  },
  xidTokenForAnotherXid: {
    setup: () => {
      const built = paths.xidBound();
      Object.assign(built.req.p, {
        uid: 502,
        pid: 3,
        xid_participant: true,
        jwt_xid: "external-person-old",
        jwt_conversation_id: "conv1",
      });
      (built.req.headers as Record<string, string>).authorization =
        "Bearer sample-token";
      return built;
    },
    answer: { next: "ok" },
    level: "info",
    line: {
      node_identity: "xid_token",
      node_token_scope: "this",
      node_new_user: true,
      node_new_participant: true,
      node_xid: "bound",
      node_token: "xid",
    },
  },
  signedInAccount: {
    setup: () => {
      const built = paths.newAnonymous();
      Object.assign(built.req.p, { uid: 502, oidc_sub: "sample-subject" });
      return built;
    },
    answer: { next: "ok" },
    level: "info",
    line: {
      node_identity: "account",
      node_token_scope: "none",
      node_new_user: false,
      node_new_participant: true,
      node_xid: "none",
      node_token: "standard_user",
    },
  },
};

/** The line `c` expects, with the fields it leaves out removed. */
function expectedLine(c: ReplyCase) {
  const line: Record<string, unknown> = { ...LINE, ...c.line };
  for (const key of Object.keys(line)) {
    if (line[key] === undefined) delete line[key];
  }
  return line;
}

/** Inputs the line must never copy. */
const NEVER_COPIED =
  /sentinel|sample|external-person|token-value|Bearer|50[1-4]|"pid"|"uid"/;

describe("participant_reply line: refusals, errors, races and tokens", () => {
  test.each(Object.keys(cases))(
    "%s: the request's answer and its line",
    async (name) => {
      const c = cases[name];
      const built = answerable(c.setup());
      const next = await run(built);

      if ("status" in c.answer) {
        expect(next).not.toHaveBeenCalled();
        expect(answer(built).statusCode).toBe(c.answer.status);
      } else if (c.answer.next === "ok") {
        expect(next.mock.calls).toStrictEqual([[]]);
      } else {
        expect(next).toHaveBeenCalledTimes(1);
        expect((next.mock.calls[0][0] as Error).message).toBe(c.answer.next);
      }

      const { level, line } = onlyLine();
      expect(level).toBe(mocked[c.level]);
      expect(line).toStrictEqual(expectedLine(c));
      expect(JSON.stringify(line)).not.toMatch(NEVER_COPIED);
    }
  );

  test("an account check that could not be made is an error, not the account refusal", async () => {
    restoreDefaults();
    const failed = answerable(cases.accountCheckFailed.setup());
    await run(failed);
    const failedLine = onlyLine();

    restoreDefaults();
    const refused = answerable(cases.accountRefused.setup());
    await run(refused);
    const refusedLine = onlyLine();

    // The two answers are the account check's own, unchanged.
    expect(answer(failed)).toStrictEqual({
      statusCode: 500,
      body: {
        error: "polis_err_participant_creation",
        message: "polis_err_participant_creation",
        status: 500,
      },
    });
    expect(answer(refused)).toStrictEqual({
      statusCode: 403,
      body: {
        error: "polis_err_xid_owner_account",
        message: "polis_err_xid_owner_account",
        status: 403,
      },
    });
    expect(failedLine.level).toBe(mocked.error);
    expect(failedLine.line).toMatchObject({ node_refusal: "error" });
    expect(refusedLine.level).toBe(mocked.warn);
    expect(refusedLine.line).toMatchObject({ node_refusal: "xid_account" });
    // Nothing else on the two lines differs.
    expect({ ...(failedLine.line as object), node_refusal: "-" }).toStrictEqual(
      { ...(refusedLine.line as object), node_refusal: "-" }
    );
  });

  test.each(Object.keys(cases))(
    "%s: a logger that throws on the line changes nothing about the answer",
    async (name) => {
      const observe = async (throwing: boolean) => {
        restoreDefaults();
        if (throwing) {
          for (const fn of [mocked.info, mocked.warn, mocked.error]) {
            fn.mockImplementation((message: unknown) => {
              if (message === "participant_reply") {
                throw new Error("logger down");
              }
            });
          }
        }
        const built = answerable(cases[name].setup());
        const next = await run(built);
        return {
          next: [...next.mock.calls],
          answer: answer(built),
          p: built.req.p,
          writes: {
            createAnonUser: [...mocked.createAnonUser.mock.calls],
            addParticipant: mocked.addParticipantAndMetadata.mock.calls.length,
            createXidRecord: [...mocked.createXidRecord.mock.calls],
            failJson: mocked.failJson.mock.calls.map((call) => call.slice(1)),
          },
          attempted: participantReplyCalls().length,
        };
      };

      const ok = await observe(false);
      const bad = await observe(true);
      expect(ok.attempted).toBe(1);
      expect(bad.attempted).toBe(1);
      expect(bad).toStrictEqual(ok);
    }
  );

  test("before the conversation is resolved: no zid and no token scope, and no input copied", async () => {
    const built = build({
      zid: undefined,
      uid: 9876543,
      pid: 8765432,
      xid: "sentinel-xid",
      oidc_sub: "sentinel-subject",
      x_email: "sentinel@example.invalid",
      x_name: "sentinel-name",
      x_profile_image_url: "https://example.invalid/sentinel",
    });
    Object.assign(built.req.headers, {
      authorization: "Bearer sentinel-token",
      "user-agent": "sentinel-agent",
      "x-forwarded-for": "192.0.2.71",
      origin: "https://example.invalid/sentinel",
    });
    await run(built);
    const line = onlyLine().line as Record<string, unknown>;
    expect(Object.keys(line).sort()).toStrictEqual(
      [
        "listener",
        "route",
        "request_id",
        "node_identity",
        "node_new_user",
        "node_new_participant",
        "node_xid",
        "node_token",
        "node_refusal",
      ].sort()
    );
    expect(JSON.stringify(line)).not.toMatch(
      /sentinel|9876543|8765432|192\.0\.2|example/
    );
  });
});
