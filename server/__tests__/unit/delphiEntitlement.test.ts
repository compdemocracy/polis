/**
 * Whether an account may use Polis 2, asked in one place
 * (src/routes/delphi/entitlement.ts) by the four routes that start Delphi work
 * (a pipeline run, a narrative batch, a collective statement, the legacy
 * narrative) and answered to the signed-in caller by GET /api/v3/delphi/me.
 *
 * POLIS_DELPHI_ENTITLEMENT (Config.delphiEntitlement) says where the answer
 * comes from:
 *   claim (the default) — the access token's delphi_enabled claim, exactly as
 *     before; the database is never read for it;
 *   claim_or_db — the claim, or a row for the account in delphi_entitlements;
 *   db — a row only.
 * The database answer is one primary-key read on the ordinary read-write pool.
 * The owner check that follows (generationOwner.ts) is unchanged in every mode.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

const NOT_OWNER = "polis_err_delphi_not_conversation_owner";
const REPORT = "r1generated";
const OWNED_ZID = 101;
const OWNER_UID = 1;
const OTHER_UID = 3;
const GRANTED_OWNER_UID = 4; // owns the conversation, has a row, no claim

const mockQuery = jest.fn<(...args: any[]) => Promise<any>>();
const mockQueryReadOnly = jest.fn<(...args: any[]) => Promise<any>>();
const mockQueryCallback = jest.fn<(...args: any[]) => unknown>();
const mockZidFromReport = jest.fn<(...args: any[]) => Promise<any>>();
const mockZidForRid = jest.fn<(...args: any[]) => Promise<any>>();
const mockAdmit = jest.fn<(...args: any[]) => Promise<any>>();
const mockProvider = jest.fn<(...args: any[]) => Promise<any>>();
const mockDynamo = jest.fn<(...args: any[]) => Promise<any>>();
const mockCluster = jest.fn<(...args: any[]) => Promise<any>>();
const mockStorageInit = jest.fn<(...args: any[]) => Promise<any>>();

// Every entry point of the database module, so a read through any of them is
// seen (the entitlement read is expected on queryP only).
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP: (...args: any[]) => mockQuery(...args),
    queryP_readOnly: (...args: any[]) => mockQueryReadOnly(...args),
    queryP_metered: (...args: any[]) => mockQueryReadOnly(...args),
    queryP_metered_readOnly: (...args: any[]) => mockQueryReadOnly(...args),
    queryP_readOnly_wRetryIfEmpty: (...args: any[]) =>
      mockQueryReadOnly(...args),
    queryP_reportExport: (...args: any[]) => mockQueryReadOnly(...args),
    queryP_agentExchange: (...args: any[]) => mockQueryReadOnly(...args),
    query: (...args: any[]) => mockQueryCallback(...args),
    query_readOnly: (...args: any[]) => mockQueryCallback(...args),
  },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    ...(jest.requireActual("../../src/config") as { default: object }).default,
    adminUIDs: "[9]",
    anthropicApiKey: "generated-test-key",
  },
}));
jest.mock("../../src/utils/parameter", () => ({
  getZidFromReport: (...args: any[]) => mockZidFromReport(...args),
}));
jest.mock("../../src/utils/zinvite", () => ({
  getZidForRid: (...args: any[]) => mockZidForRid(...args),
}));
jest.mock("../../src/routes/delphi/jobGuard", () => ({
  admitDelphiJob: (...args: any[]) => mockAdmit(...args),
  JobAdmissionUnavailableError: class extends Error {},
  JOB_QUEUE_TABLE: "Delphi_JobQueue",
}));
jest.mock("../../src/utils/delphiResults", () => ({
  resultClient: () => ({ send: (...args: any[]) => mockDynamo(...args) }),
}));
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: class {
    messages = { create: (...args: any[]) => mockProvider(...args) };
  },
}));
jest.mock("../../src/utils/commentClusters", () => ({
  getCommentIdsForCluster: (...args: any[]) => mockCluster(...args),
}));
jest.mock("../../src/utils/storage", () => ({
  __esModule: true,
  default: class {
    initTable = (...args: any[]) => mockStorageInit(...args);
  },
}));
jest.mock("../../src/utils/dynamoClient", () => ({
  AwsCredentialsConfigurationError: class extends Error {},
}));
jest.mock("../../src/report", () => ({ sendCommentGroupsSummary: jest.fn() }));
jest.mock("../../src/report_experimental/topics-example", () => ({
  getTopicsFromRID: jest.fn(),
}));

import { handle_POST_delphi_jobs } from "../../src/routes/delphi/jobs";
import { handle_POST_delphi_batch_reports } from "../../src/routes/delphi/batchReports";
import { handle_POST_collectiveStatement } from "../../src/routes/collectiveStatement";
import { handle_GET_reportNarrative } from "../../src/routes/reportNarrative";
import {
  DELPHI_ENTITLEMENT_READ,
  handle_GET_delphi_me,
  isDelphiEntitled,
} from "../../src/routes/delphi/entitlement";
import Config from "../../src/config";

type Source = "claim" | "claim_or_db" | "db";
type Reply = { status: number; body: any };
type Caller = { uid?: unknown; delphiEnabled?: unknown };

const DEFAULT_SOURCE = (Config as { delphiEntitlement: string })
  .delphiEntitlement;

function setSource(source: string): void {
  (Config as { delphiEntitlement: string }).delphiEntitlement = source;
}

// The accounts with a row in delphi_entitlements; each test may change it.
let granted: Set<number>;

const ownerRead = /^SELECT owner FROM conversations WHERE zid = \(\$1\);$/;

function entitlementReads(): unknown[][] {
  return mockQuery.mock.calls.filter(([sql]) =>
    /delphi_entitlements/.test(String(sql))
  );
}

/** No call to any database entry point named the table. */
function expectTableNeverRead(): void {
  for (const fn of [mockQuery, mockQueryReadOnly, mockQueryCallback])
    for (const call of fn.mock.calls)
      expect(String(call[0])).not.toMatch(/delphi_entitlements/);
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    streamed: [] as string[],
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  res.writeHead = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.write = (chunk: string) => res.streamed.push(chunk);
  res.flush = () => undefined;
  res.end = () => undefined;
  return res;
}

async function run(
  handler: (req: any, res: any) => unknown,
  req: Record<string, unknown>
): Promise<Reply> {
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}

interface Route {
  name: string;
  call: (caller: Caller) => Promise<Reply>;
  proceeded: () => void;
  /** The reply an account that may not use Polis 2 gets, byte for byte as today. */
  refused: Reply;
  /** The reply when a database read fails. */
  readFails: number;
}

const statementBody = {
  report_id: REPORT,
  topic_key: "0000c5a1-0000-0000-0000-0000000000b2#0#1",
  topic_name: "Generated topic",
  qualifying_tids: [0, 1, 2],
  group_consensus: { 0: 0.9, 1: 0.9, 2: 0.9 },
};

const routes: Route[] = [
  {
    name: "POST /api/v3/delphi/jobs",
    call: (p) =>
      run(handle_POST_delphi_jobs, {
        p,
        body: { report_id: REPORT, job_type: "FULL_PIPELINE" },
      }),
    proceeded: () => expect(mockAdmit).toHaveBeenCalledTimes(1),
    refused: {
      status: 403,
      body: {
        error: "polis_err_delphi_jobs_delphi_disabled",
        message: "polis_err_delphi_jobs_delphi_disabled",
        status: 403,
      },
    },
    readFails: 500,
  },
  {
    name: "POST /api/v3/delphi/batchReports",
    call: (p) =>
      run(handle_POST_delphi_batch_reports, {
        p,
        body: { report_id: REPORT, model: "generated-model" },
      }),
    proceeded: () => expect(mockAdmit).toHaveBeenCalledTimes(1),
    refused: {
      status: 200,
      body: {
        status: "error",
        message: "Error processing request",
        error: "Unauthorized",
        report_id: REPORT,
      },
    },
    readFails: 200,
  },
  {
    name: "POST /api/v3/collectiveStatement",
    call: (p) =>
      run(handle_POST_collectiveStatement, { p, body: statementBody }),
    proceeded: () => expect(mockCluster).toHaveBeenCalledTimes(1),
    refused: {
      status: 500,
      body: {
        status: "error",
        message: "Error generating collective statement",
        error: "Unauthorized",
      },
    },
    readFails: 500,
  },
  {
    name: "GET /api/v3/reportNarrative",
    call: (p) =>
      run(handle_GET_reportNarrative, {
        p: { rid: 11, ...p },
        query: { report_id: REPORT },
      }),
    proceeded: () => expect(mockStorageInit).toHaveBeenCalledTimes(1),
    refused: {
      status: 503,
      body: {
        error: "polis_err_report_storage",
        message: "polis_err_report_storage",
        status: 503,
      },
    },
    readFails: 503,
  },
];

function expectNothingStarted() {
  for (const fn of [
    mockAdmit,
    mockProvider,
    mockDynamo,
    mockCluster,
    mockStorageInit,
  ])
    expect(fn).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const fn of [
    mockQuery,
    mockQueryReadOnly,
    mockQueryCallback,
    mockZidFromReport,
    mockZidForRid,
    mockAdmit,
    mockProvider,
    mockDynamo,
    mockCluster,
    mockStorageInit,
  ])
    fn.mockReset();
  granted = new Set([GRANTED_OWNER_UID, OTHER_UID]);
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = String(sql).trim();
    if (ownerRead.test(text)) {
      const zid = Number(params[0]);
      return zid === OWNED_ZID
        ? [{ owner: OWNER_UID }]
        : zid === OWNED_ZID + 1
        ? [{ owner: GRANTED_OWNER_UID }]
        : [];
    }
    if (text === DELPHI_ENTITLEMENT_READ)
      return granted.has(Number(params[0])) ? [{ "?column?": 1 }] : [];
    throw new Error(`unexpected query: ${sql}`);
  });
  mockQueryReadOnly.mockRejectedValue(new Error("no replica read expected"));
  mockQueryCallback.mockImplementation(() => {
    throw new Error("no callback query expected");
  });
  mockZidFromReport.mockResolvedValue(OWNED_ZID);
  mockZidForRid.mockResolvedValue(OWNED_ZID);
  mockAdmit.mockResolvedValue({
    outcome: "admitted",
    jobId: "generated-job",
    jobStatus: "PENDING",
    workLive: true,
  });
  mockCluster.mockResolvedValue([]);
  mockStorageInit.mockResolvedValue({
    success: false,
    error: { isTableNotFound: true },
  });
  mockProvider.mockRejectedValue(new Error("no model call expected"));
  mockDynamo.mockRejectedValue(new Error("no DynamoDB call expected"));
});

afterEach(() => setSource(DEFAULT_SOURCE));

test("the default is claim", () => {
  expect(DEFAULT_SOURCE).toBe("claim");
});

test("the database read is one primary-key SELECT of delphi_entitlements", () => {
  expect(DELPHI_ENTITLEMENT_READ).toBe(
    "SELECT 1 FROM delphi_entitlements WHERE uid = ($1);"
  );
});

describe("isDelphiEntitled", () => {
  const truthy = [true, 1, "true", "yes", {}];
  const falsy = [false, undefined, null, 0, ""];

  describe("claim (the default)", () => {
    test.each(truthy)("a claim of %p: yes, and nothing is read", async (v) => {
      expect(await isDelphiEntitled({ uid: OTHER_UID, delphiEnabled: v })).toBe(
        true
      );
      expectTableNeverRead();
      expect(mockQuery).not.toHaveBeenCalled();
    });
    test.each(falsy)(
      "a claim of %p: no, and nothing is read, even with a row",
      async (v) => {
        expect(
          await isDelphiEntitled({ uid: OTHER_UID, delphiEnabled: v })
        ).toBe(false);
        expectTableNeverRead();
        expect(mockQuery).not.toHaveBeenCalled();
      }
    );
  });

  describe("claim_or_db", () => {
    beforeEach(() => setSource("claim_or_db"));
    test("a claim: yes, with no read", async () => {
      expect(
        await isDelphiEntitled({ uid: OWNER_UID, delphiEnabled: true })
      ).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    });
    test("no claim and a row: yes, after one read by primary key", async () => {
      expect(await isDelphiEntitled({ uid: OTHER_UID })).toBe(true);
      expect(mockQuery.mock.calls).toEqual([
        [DELPHI_ENTITLEMENT_READ, [OTHER_UID]],
      ]);
      expect(mockQueryReadOnly).not.toHaveBeenCalled();
    });
    test("no claim and no row: no", async () => {
      expect(
        await isDelphiEntitled({ uid: OWNER_UID, delphiEnabled: false })
      ).toBe(false);
      expect(entitlementReads()).toEqual([
        [DELPHI_ENTITLEMENT_READ, [OWNER_UID]],
      ]);
    });
  });

  describe("db", () => {
    beforeEach(() => setSource("db"));
    test("a claim and no row: no", async () => {
      expect(
        await isDelphiEntitled({ uid: OWNER_UID, delphiEnabled: true })
      ).toBe(false);
      expect(mockQuery.mock.calls).toEqual([
        [DELPHI_ENTITLEMENT_READ, [OWNER_UID]],
      ]);
    });
    test("a row and no claim: yes", async () => {
      expect(await isDelphiEntitled({ uid: String(OTHER_UID) })).toBe(true);
      expect(mockQuery.mock.calls).toEqual([
        [DELPHI_ENTITLEMENT_READ, [OTHER_UID]],
      ]);
    });
  });

  describe.each(["claim_or_db", "db"])("%s and an account number", (source) => {
    beforeEach(() => setSource(source));
    test.each([undefined, null, 0, -3, 1.5, "3abc", "03", 2147483648, {}])(
      "that is not one (%p): no, with no read",
      async (uid) => {
        expect(await isDelphiEntitled({ uid })).toBe(false);
        expect(mockQuery).not.toHaveBeenCalled();
      }
    );
    test("a failed read throws, so nothing is decided on a guess", async () => {
      mockQuery.mockRejectedValue(new Error("generated database failure"));
      await expect(isDelphiEntitled({ uid: OTHER_UID })).rejects.toThrow(
        "generated database failure"
      );
    });
  });

  test.each(["", "CLAIM", "database", "claim,db"])(
    "an unknown setting value (%p) reaching it answers as claim",
    async (source) => {
      setSource(source);
      expect(await isDelphiEntitled({ uid: OTHER_UID })).toBe(false);
      expect(
        await isDelphiEntitled({ uid: OWNER_UID, delphiEnabled: true })
      ).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    }
  );
});

describe.each(routes)("$name", (route) => {
  describe("claim (the default): exactly as before, and the table is never read", () => {
    test("the owner with the claim gets past authorization", async () => {
      await route.call({ uid: OWNER_UID, delphiEnabled: true });
      route.proceeded();
      expect(mockQuery.mock.calls).toEqual([
        [expect.stringMatching(ownerRead), [OWNED_ZID]],
      ]);
      expectTableNeverRead();
    });
    test("an account with a row but no claim gets today's refusal", async () => {
      const reply = await route.call({ uid: OTHER_UID, delphiEnabled: false });
      expect(reply).toEqual(route.refused);
      expect(mockQuery).not.toHaveBeenCalled();
      expectTableNeverRead();
      expectNothingStarted();
    });
    test("a claim holder who is not the owner is refused as the owner check refuses", async () => {
      const reply = await route.call({ uid: OTHER_UID, delphiEnabled: true });
      expect(reply).toEqual({
        status: 403,
        body: { error: NOT_OWNER, message: NOT_OWNER, status: 403 },
      });
      expectTableNeverRead();
      expectNothingStarted();
    });
  });

  describe("claim_or_db", () => {
    beforeEach(() => setSource("claim_or_db"));
    test("the owner with the claim proceeds, with no entitlement read", async () => {
      await route.call({ uid: OWNER_UID, delphiEnabled: true });
      route.proceeded();
      expect(entitlementReads()).toEqual([]);
    });
    test("the owner with a row and no claim proceeds: one entitlement read, then the owner read", async () => {
      mockZidFromReport.mockResolvedValue(OWNED_ZID + 1);
      mockZidForRid.mockResolvedValue(OWNED_ZID + 1);
      await route.call({ uid: GRANTED_OWNER_UID });
      route.proceeded();
      expect(mockQuery.mock.calls).toEqual([
        [DELPHI_ENTITLEMENT_READ, [GRANTED_OWNER_UID]],
        [expect.stringMatching(ownerRead), [OWNED_ZID + 1]],
      ]);
    });
    test("an account with neither gets today's refusal and no owner read", async () => {
      const reply = await route.call({ uid: OWNER_UID, delphiEnabled: false });
      expect(reply).toEqual(route.refused);
      expect(mockQuery.mock.calls).toEqual([
        [DELPHI_ENTITLEMENT_READ, [OWNER_UID]],
      ]);
      expectNothingStarted();
    });
    test("a row does not reach someone else's conversation", async () => {
      const reply = await route.call({ uid: OTHER_UID });
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe(NOT_OWNER);
      expectNothingStarted();
    });
  });

  describe("db", () => {
    beforeEach(() => setSource("db"));
    test("the owner with the claim but no row gets today's refusal", async () => {
      const reply = await route.call({ uid: OWNER_UID, delphiEnabled: true });
      expect(reply).toEqual(route.refused);
      expect(mockQuery.mock.calls).toEqual([
        [DELPHI_ENTITLEMENT_READ, [OWNER_UID]],
      ]);
      expectNothingStarted();
    });
    test("the owner with a row proceeds", async () => {
      mockZidFromReport.mockResolvedValue(OWNED_ZID + 1);
      mockZidForRid.mockResolvedValue(OWNED_ZID + 1);
      await route.call({ uid: GRANTED_OWNER_UID, delphiEnabled: false });
      route.proceeded();
    });
    test("a row does not reach someone else's conversation", async () => {
      const reply = await route.call({ uid: OTHER_UID, delphiEnabled: true });
      expect(reply).toEqual({
        status: 403,
        body: { error: NOT_OWNER, message: NOT_OWNER, status: 403 },
      });
      expectNothingStarted();
    });
    test("when the entitlement read fails nothing is started", async () => {
      mockQuery.mockRejectedValue(new Error("generated database failure"));
      const reply = await route.call({ uid: GRANTED_OWNER_UID });
      expect(reply.status).toBe(route.readFails);
      expect(reply.body.error).not.toBe(NOT_OWNER);
      expectNothingStarted();
    });
  });
});

describe("GET /api/v3/delphi/me", () => {
  const me = (p: Caller) => run(handle_GET_delphi_me, { p });

  test.each([
    [{ uid: OWNER_UID, delphiEnabled: true }, true],
    [{ uid: OTHER_UID, delphiEnabled: false }, false],
    [{ uid: OTHER_UID }, false],
  ])("claim: %p answers %p, reading nothing", async (caller, answer) => {
    expect(await me(caller)).toEqual({
      status: 200,
      body: { delphi_entitled: answer },
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expectTableNeverRead();
  });

  test.each([
    ["claim_or_db", { uid: OWNER_UID, delphiEnabled: true }, true],
    ["claim_or_db", { uid: OTHER_UID }, true],
    ["claim_or_db", { uid: OWNER_UID }, false],
    ["db", { uid: OWNER_UID, delphiEnabled: true }, false],
    ["db", { uid: OTHER_UID }, true],
    ["db", {}, false],
  ] as Array<[Source, Caller, boolean]>)(
    "%s: %p answers %p",
    async (source, caller, answer) => {
      setSource(source);
      expect(await me(caller)).toEqual({
        status: 200,
        body: { delphi_entitled: answer },
      });
    }
  );

  test("a failed read answers 500 and says nothing about the account", async () => {
    setSource("db");
    mockQuery.mockRejectedValue(new Error("generated database failure"));
    expect(await me({ uid: OTHER_UID })).toEqual({
      status: 500,
      body: {
        error: "polis_err_delphi_entitlement",
        message: "polis_err_delphi_entitlement",
        status: 500,
      },
    });
  });
});
