/**
 * Who may start Delphi work on a conversation: the four routes that start a
 * pipeline run, a narrative batch, a collective statement or the legacy
 * narrative.
 *
 * Each route checks the delphi_enabled claim first, exactly as before: a
 * caller without it gets the reply it always got, and no ownership read is
 * made. A caller WITH the claim must also own the conversation the request
 * names. Anyone else is refused with HTTP 403 and one code, the same on all
 * four routes, before anything is admitted, written or sent to a model. A
 * site administrator (a uid in ADMIN_UIDS) may start work on any conversation.
 * Moderators on the owner's site get no right from this.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const NOT_OWNER = "polis_err_delphi_not_conversation_owner";
const REPORT = "r1generated";
const OWNED_ZID = 101;
const OWNER_UID = 1;
const OTHER_UID = 3;
// Listed in ADMIN_UIDS below (the server's isPolisDev list); owns nothing.
const ADMIN_UID = 9;

const mockQuery = jest.fn<(...args: any[]) => Promise<any>>();
const mockQueryReadOnly = jest.fn<(...args: any[]) => Promise<any>>();
const mockZidFromReport = jest.fn<(...args: any[]) => Promise<any>>();
const mockZidForRid = jest.fn<(...args: any[]) => Promise<any>>();
const mockAdmit = jest.fn<(...args: any[]) => Promise<any>>();
const mockProvider = jest.fn<(...args: any[]) => Promise<any>>();
const mockDynamo = jest.fn<(...args: any[]) => Promise<any>>();
const mockCluster = jest.fn<(...args: any[]) => Promise<any>>();
const mockStorageInit = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP: (...args: any[]) => mockQuery(...args),
    queryP_readOnly: (...args: any[]) => mockQueryReadOnly(...args),
  },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
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

type Reply = { status: number; body: any };

function makeRes() {
  const res: any = { statusCode: 200, body: undefined, streamed: [] as string[] };
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

type Caller = { uid?: unknown; delphiEnabled?: unknown };

interface Route {
  name: string;
  call: (caller: Caller) => Promise<Reply>;
  /** Evidence that the request got past authorization, as today. */
  proceeded: () => void;
  /** The reply a caller without the claim gets today, byte for byte. */
  noClaim: Reply;
  /** The reply when the ownership read itself fails (fail closed). */
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
    proceeded: () => {
      expect(mockAdmit).toHaveBeenCalledTimes(1);
      expect((mockAdmit.mock.calls[0][0] as any).scope.conversationId).toBe(
        String(OWNED_ZID)
      );
    },
    noClaim: {
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
    noClaim: {
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
    call: (p) => run(handle_POST_collectiveStatement, { p, body: statementBody }),
    proceeded: () => expect(mockCluster).toHaveBeenCalledTimes(1),
    noClaim: {
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
    noClaim: {
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

const ownerRead = /^SELECT owner FROM conversations WHERE zid = \(\$1\);$/;

function expectNothingStarted() {
  for (const fn of [mockAdmit, mockProvider, mockDynamo, mockCluster, mockStorageInit])
    expect(fn).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const fn of [
    mockQuery,
    mockQueryReadOnly,
    mockZidFromReport,
    mockZidForRid,
    mockAdmit,
    mockProvider,
    mockDynamo,
    mockCluster,
    mockStorageInit,
  ])
    fn.mockReset();
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (ownerRead.test(String(sql).trim()))
      return Number(params[0]) === OWNED_ZID ? [{ owner: OWNER_UID }] : [];
    throw new Error(`unexpected query: ${sql}`);
  });
  mockQueryReadOnly.mockRejectedValue(new Error("no replica read expected"));
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

describe.each(routes)("$name", (route) => {
  test("the owner with the claim gets past authorization, as today", async () => {
    await route.call({ uid: OWNER_UID, delphiEnabled: true });
    route.proceeded();
    const reads = mockQuery.mock.calls.filter(([sql]) => ownerRead.test(String(sql).trim()));
    expect(reads).toEqual([[expect.any(String), [OWNED_ZID]]]);
  });

  test("a claim holder who does not own the conversation is refused before anything starts", async () => {
    const reply = await route.call({ uid: OTHER_UID, delphiEnabled: true });
    expect(reply).toEqual({
      status: 403,
      body: { error: NOT_OWNER, message: NOT_OWNER, status: 403 },
    });
    expectNothingStarted();
    // One read of the conversation's owner, by primary key, on the
    // read-write pool; nothing on the replica.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0]).trim()).toMatch(ownerRead);
    expect(mockQuery.mock.calls[0][1]).toEqual([OWNED_ZID]);
    expect(mockQueryReadOnly).not.toHaveBeenCalled();
  });

  test("a claim holder with no account id is refused", async () => {
    const reply = await route.call({ delphiEnabled: true });
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe(NOT_OWNER);
    expectNothingStarted();
  });

  // The claim check is unchanged: any falsy value is "no claim".
  test.each([false, undefined, null, 0, ""])(
    "a caller without the claim (%p) gets today's reply and no ownership read",
    async (claim) => {
      const reply = await route.call({ uid: OWNER_UID, delphiEnabled: claim });
      expect(reply).toEqual(route.noClaim);
      expect(mockQuery).not.toHaveBeenCalled();
      expectNothingStarted();
    }
  );

  test("a site administrator with the claim may start work on a conversation it does not own", async () => {
    await route.call({ uid: ADMIN_UID, delphiEnabled: true });
    route.proceeded();
  });

  test("a site administrator cannot start work on a conversation that does not exist", async () => {
    mockZidFromReport.mockResolvedValue(999);
    mockZidForRid.mockResolvedValue(999);
    const reply = await route.call({ uid: ADMIN_UID, delphiEnabled: true });
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe(NOT_OWNER);
    expectNothingStarted();
  });

  test("a site administrator without the claim gets today's reply", async () => {
    const reply = await route.call({ uid: ADMIN_UID, delphiEnabled: false });
    expect(reply).toEqual(route.noClaim);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("a conversation that does not exist is nobody's to start work on", async () => {
    mockZidFromReport.mockResolvedValue(999);
    mockZidForRid.mockResolvedValue(999);
    const reply = await route.call({ uid: OWNER_UID, delphiEnabled: true });
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe(NOT_OWNER);
    expectNothingStarted();
  });

  test("when the ownership read fails nothing is started", async () => {
    mockQuery.mockRejectedValue(new Error("generated database failure"));
    const reply = await route.call({ uid: OWNER_UID, delphiEnabled: true });
    expect(reply.status).toBe(route.readFails);
    expect(reply.body.error).not.toBe(NOT_OWNER);
    expectNothingStarted();
  });
});

describe("POST /api/v3/delphi/jobs with an internal conversation number", () => {
  const submit = (uid: number, conversation_id: unknown) =>
    run(handle_POST_delphi_jobs, {
      p: { uid, delphiEnabled: true },
      body: { conversation_id, job_type: "FULL_PIPELINE" },
    });

  test.each([OWNED_ZID, String(OWNED_ZID)])(
    "is accepted from the owner, as today (%p)",
    async (conversationId) => {
      const reply = await submit(OWNER_UID, conversationId);
      expect(reply.status).toBe(200);
      expect(mockAdmit).toHaveBeenCalledTimes(1);
      expect(mockZidFromReport).not.toHaveBeenCalled();
    }
  );

  test("is refused from a claim holder who does not own it", async () => {
    const reply = await submit(OTHER_UID, OWNED_ZID);
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe(NOT_OWNER);
    expect(mockAdmit).not.toHaveBeenCalled();
  });

  // (0 and "" are refused earlier, as missing, with today's 400.)
  test.each(["2demo", "101abc", "0101", "1.5", -1, 2147483648])(
    "a value that is no conversation number (%p) is owned by nobody",
    async (conversationId) => {
      const reply = await submit(OWNER_UID, conversationId);
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe(NOT_OWNER);
      expect(mockAdmit).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    }
  );

  // The job runs on conversation_id but carries report_id into the paths its
  // stages write, so the two must name one conversation, whoever sends them.
  describe("sent together with a report_id", () => {
    const OTHER_ZID = 102;
    const pair = (uid: number, conversation_id: unknown, report_id: string) =>
      run(handle_POST_delphi_jobs, {
        p: { uid, delphiEnabled: true },
        body: { conversation_id, report_id, job_type: "FULL_PIPELINE" },
      });
    beforeEach(() =>
      mockZidFromReport.mockImplementation(async (reportId: string) =>
        reportId === "r1other" ? OTHER_ZID : reportId === REPORT ? OWNED_ZID : null
      )
    );

    test.each([OWNED_ZID, String(OWNED_ZID)])(
      "naming one conversation (%p), is accepted from its owner, as today",
      async (conversationId) => {
        const reply = await pair(OWNER_UID, conversationId, REPORT);
        expect(reply.status).toBe(200);
        expect(mockAdmit).toHaveBeenCalledTimes(1);
        expect((mockAdmit.mock.calls[0][0] as any).scope.reportId).toBe(REPORT);
      }
    );

    test.each([
      ["the owner of the conversation", OWNER_UID],
      ["a site administrator", ADMIN_UID],
    ])(
      "naming another conversation's report is refused from %s, before anything starts",
      async (_who, uid) => {
        const reply = await pair(uid, OWNED_ZID, "r1other");
        expect(reply).toEqual({
          status: 403,
          body: { error: NOT_OWNER, message: NOT_OWNER, status: 403 },
        });
        expectNothingStarted();
      }
    );

    test("naming a report that does not exist is refused", async () => {
      const reply = await pair(OWNER_UID, OWNED_ZID, "r1absent");
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe(NOT_OWNER);
      expectNothingStarted();
    });
  });
});
