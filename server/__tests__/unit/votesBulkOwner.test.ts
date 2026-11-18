/**
 * Who may import a vote CSV into a conversation (POST /api/v3/votes-bulk).
 *
 * The delphi_enabled claim is checked first, exactly as before: a caller
 * without it gets the reply it always got, and nothing is read. A caller WITH
 * the claim must also own the conversation the request names, or be a site
 * administrator (a uid in ADMIN_UIDS, read by shape as the Delphi routes read
 * it). Anyone else is refused with HTTP 403 and one code before the CSV is
 * read, parsed or stored and before anything is read or written for the
 * conversation. For the owner and for an administrator the import goes on
 * exactly as before, its declared vote sign included.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NOT_OWNER = "polis_err_votes_bulk_not_conversation_owner";
const ZID = 7;
const OWNER_UID = 1;
const OTHER_UID = 3;
// Listed in ADMIN_UIDS below; owns nothing.
const ADMIN_UID = 9;
const VALID_ADMIN_LIST = "[9]";
const OWNER_READ = "SELECT owner FROM conversations";

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<any>>();
const mockQueryReadOnly =
  jest.fn<(sql: string, params?: unknown[]) => Promise<any>>();
const mockS3Send = jest.fn<(command: any) => Promise<any>>();
const mockSqsSend = jest.fn<(command: any) => Promise<any>>();
const mockCheckDeclaration = jest.fn<(line: string | null) => unknown>();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: (command: unknown) => mockS3Send(command),
  })),
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
}));
jest.mock("../../src/utils/sqs", () => ({
  sqsClient: { send: (command: unknown) => mockSqsSend(command) },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP: (sql: string, params?: unknown[]) => mockQuery(sql, params),
    queryP_readOnly: (sql: string, params?: unknown[]) =>
      mockQueryReadOnly(sql, params),
  },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    ...(jest.requireActual("../../src/config") as { default: object }).default,
    adminUIDs: "[9]",
  },
}));
// The declared-sign check, observed: it is the first thing that reads the CSV.
jest.mock("../../src/votes/convention", () => {
  const actual = jest.requireActual("../../src/votes/convention") as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    checkImportDeclaration: (line: string | null) => mockCheckDeclaration(line),
  };
});
jest.mock("../../src/server-helpers", () => ({}));
jest.mock("../../src/nextComment", () => ({}));
jest.mock("../../src/user", () => ({}));

import Config from "../../src/config";
import { handle_POST_votes_bulk } from "../../src/routes/votes";
import { IMPORT_TARGET_NOT_EMPTY } from "../../src/utils/import-target";
import { VOTE_DECLARATION_ERRORS } from "../../src/votes/convention";

const actualConvention = jest.requireActual(
  "../../src/votes/convention"
) as typeof import("../../src/votes/convention");

const fixture = (name: string) =>
  readFileSync(
    join(__dirname, "..", "fixtures", "vote-declaration", name),
    "utf8"
  );
const undeclared = (text: string) => text.slice(text.indexOf("\n") + 1);
const PLAIN_CSV = undeclared(fixture("import-declared.csv"));
const DECLARED_CSV = fixture("import-declared.csv");

const PROCESSING = {
  status: "processing",
  message: "Vote import started. This may take a few minutes.",
};
const REFUSED = { error: NOT_OWNER, message: NOT_OWNER, status: 403 };

// What the stores answer; each test may change them.
let ownerRows: unknown[] | Error;
let occupied: boolean;
let mappable: boolean;

beforeEach(() => {
  jest.clearAllMocks();
  (Config as { adminUIDs: string }).adminUIDs = VALID_ADMIN_LIST;
  ownerRows = [{ owner: OWNER_UID }];
  occupied = false;
  mappable = true;
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes(OWNER_READ)) {
      if (ownerRows instanceof Error) throw ownerRows;
      return ownerRows;
    }
    if (sql.includes("AS occupied")) return [{ occupied }];
    if (sql.includes("RETURNING id")) return [{ id: 11 }];
    if (sql.includes("SELECT email FROM users"))
      return [{ email: "owner@example.test" }];
    throw new Error(`unexpected query: ${sql}`);
  });
  mockQueryReadOnly.mockImplementation(async () =>
    mappable ? [{ "?column?": 1 }] : []
  );
  mockS3Send.mockResolvedValue({});
  mockSqsSend.mockResolvedValue({});
  mockCheckDeclaration.mockImplementation((line) =>
    actualConvention.checkImportDeclaration(line)
  );
});

type Reply = { status: number; body: unknown; replies: number };

async function post(
  p: Record<string, unknown>,
  body: Record<string, unknown> = { csv: PLAIN_CSV }
): Promise<Reply> {
  let status = 200;
  let replyBody: unknown;
  let replies = 0;
  const res: any = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (data: unknown) => {
      replyBody = data;
      replies++;
    },
  };
  await handle_POST_votes_bulk({ p: { zid: ZID, ...p }, body } as any, res);
  return { status, body: replyBody, replies };
}

const ownerReads = () =>
  mockQuery.mock.calls.filter(([sql]) => String(sql).includes(OWNER_READ));
const otherQueries = () =>
  mockQuery.mock.calls.filter(([sql]) => !String(sql).includes(OWNER_READ));

/** One read, the conversation's owner by its number, and nothing else. */
function expectOnlyTheOwnerRead(): void {
  expect(ownerReads()).toEqual([
    ["SELECT owner FROM conversations WHERE zid = ($1);", [ZID]],
  ]);
  expect(otherQueries()).toEqual([]);
  expect(mockQueryReadOnly).not.toHaveBeenCalled();
}

/** The CSV was not read, parsed or stored; nothing was written or queued. */
function expectNothingImported(): void {
  expect(mockCheckDeclaration).not.toHaveBeenCalled();
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockSqsSend).not.toHaveBeenCalled();
  expect(otherQueries()).toEqual([]);
  expect(mockQueryReadOnly).not.toHaveBeenCalled();
}

/** The import went on as it always has: stored, a job row, a queued message. */
function expectImported(csv: string): void {
  expect(mockCheckDeclaration).toHaveBeenCalledWith(csv.split("\n", 1)[0]);
  const put = mockS3Send.mock.calls[0]?.[0] as {
    input: { Key: string; Body: string; ContentType: string };
  };
  expect(put.input.Body).toBe(csv);
  expect(put.input.ContentType).toBe("text/csv");
  expect(put.input.Key).toMatch(
    new RegExp(`^imports/votes/${ZID}/\\d+\\.csv$`)
  );
  const job = otherQueries().find(([sql]) => sql.includes("byod_import_jobs"));
  expect(job?.[1]).toEqual([ZID, put.input.Key]);
  const message = mockSqsSend.mock.calls[0]?.[0] as {
    input: { MessageBody: string };
  };
  expect(JSON.parse(message.input.MessageBody)).toEqual({
    jobId: 11,
    zid: ZID,
    s3Key: put.input.Key,
    email: "owner@example.test",
  });
}

describe("POST /api/v3/votes-bulk and the conversation owner", () => {
  test("the owner with the claim imports as before, after one owner read", async () => {
    const reply = await post({ uid: OWNER_UID, delphiEnabled: true });
    expect(reply).toEqual({ status: 200, body: PROCESSING, replies: 1 });
    expect(ownerReads()).toHaveLength(1);
    // The owner read comes first: before the target check, the comment check
    // and every write.
    expect(String(mockQuery.mock.calls[0][0])).toContain(OWNER_READ);
    expectImported(PLAIN_CSV);
  });

  test("the owner's request is decided exactly as before in every other way", async () => {
    const owner = { uid: OWNER_UID, delphiEnabled: true };

    expect(await post(owner, {})).toEqual({
      status: 400,
      body: {
        error: "polis_err_param_missing_csv_votes",
        message: "polis_err_param_missing_csv_votes",
        status: 400,
      },
      replies: 1,
    });

    for (const [file, code] of [
      ["import-mismatch-sign.csv", VOTE_DECLARATION_ERRORS.mismatch],
      ["import-mismatch-format.csv", VOTE_DECLARATION_ERRORS.mismatch],
      ["import-malformed.csv", VOTE_DECLARATION_ERRORS.malformed],
    ]) {
      jest.clearAllMocks();
      const reply = await post(owner, { csv: fixture(file) });
      expect(reply).toEqual({
        status: 400,
        body: { error: code, message: code, status: 400 },
        replies: 1,
      });
      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockSqsSend).not.toHaveBeenCalled();
    }

    jest.clearAllMocks();
    expect(await post(owner, { csv: DECLARED_CSV })).toEqual({
      status: 200,
      body: PROCESSING,
      replies: 1,
    });
    expectImported(DECLARED_CSV);

    jest.clearAllMocks();
    occupied = true;
    const full = await post(owner);
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({
      error: IMPORT_TARGET_NOT_EMPTY,
      code: IMPORT_TARGET_NOT_EMPTY,
    });
    expect(mockS3Send).not.toHaveBeenCalled();

    jest.clearAllMocks();
    occupied = false;
    mappable = false;
    expect(await post(owner)).toEqual({
      status: 400,
      body: {
        error: "polis_err_votes_bulk_no_mappable_comments",
        message: "polis_err_votes_bulk_no_mappable_comments",
        status: 400,
      },
      replies: 1,
    });
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test.each([
    ["a CSV", { csv: PLAIN_CSV }],
    ["a CSV declaring the export convention", { csv: DECLARED_CSV }],
    ["a malformed declaration", { csv: fixture("import-malformed.csv") }],
    ["a mismatched declaration", { csv: fixture("import-mismatch-sign.csv") }],
    ["no CSV", {}],
  ] as Array<[string, Record<string, unknown>]>)(
    "a claim holder who neither owns the conversation nor administers the site, sending %s, is refused before the CSV is read",
    async (_label, body) => {
      const reply = await post({ uid: OTHER_UID, delphiEnabled: true }, body);
      expect(reply).toEqual({ status: 403, body: REFUSED, replies: 1 });
      expectOnlyTheOwnerRead();
      expectNothingImported();
    }
  );

  test("a conversation with no owner is nobody's but an administrator's", async () => {
    ownerRows = [{ owner: null }];
    const reply = await post({ uid: OTHER_UID, delphiEnabled: true });
    expect(reply).toEqual({ status: 403, body: REFUSED, replies: 1 });
    expectNothingImported();
  });

  test("a claim holder with no account number is refused, with no read", async () => {
    for (const uid of [undefined, null, 0, "", "x"]) {
      jest.clearAllMocks();
      const reply = await post({ uid, delphiEnabled: true });
      expect(reply).toEqual({ status: 403, body: REFUSED, replies: 1 });
      expect(mockQuery).not.toHaveBeenCalled();
      expectNothingImported();
    }
  });

  test("a site administrator with the claim may import into a conversation it does not own", async () => {
    const reply = await post({ uid: ADMIN_UID, delphiEnabled: true });
    expect(reply).toEqual({ status: 200, body: PROCESSING, replies: 1 });
    expect(ownerReads()).toHaveLength(1);
    expectImported(PLAIN_CSV);
  });

  test("a site administrator is refused on a conversation that does not exist", async () => {
    ownerRows = [];
    const reply = await post({ uid: ADMIN_UID, delphiEnabled: true });
    expect(reply).toEqual({ status: 403, body: REFUSED, replies: 1 });
    expectNothingImported();
  });

  test("a failed owner read answers the route's own failure, and nothing is imported", async () => {
    ownerRows = new Error("connection lost");
    const reply = await post({ uid: OWNER_UID, delphiEnabled: true });
    expect(reply.status).toBe(500);
    expect(reply.body).toMatchObject({
      error: "polis_err_post_votes_bulk",
      message: "polis_err_post_votes_bulk",
      status: 500,
    });
    expect(reply.replies).toBe(1);
    expectNothingImported();
  });

  test.each([undefined, false, 0, "", null])(
    "without the claim (%p) every caller gets today's reply, and nothing is read",
    async (delphiEnabled) => {
      for (const uid of [OWNER_UID, ADMIN_UID, OTHER_UID]) {
        jest.clearAllMocks();
        const reply = await post({ uid, delphiEnabled });
        expect(reply).toEqual({
          status: 403,
          body: {
            error: "polis_err_votes_bulk_delphi_disabled",
            message: "polis_err_votes_bulk_delphi_disabled",
            status: 403,
          },
          replies: 1,
        });
        expect(mockQuery).not.toHaveBeenCalled();
        expectNothingImported();
      }
    }
  );
});

// ADMIN_UIDS as the vote import reads it: the same reading the Delphi routes
// use. Only a JSON array of positive int4 numbers names administrators, by
// exact numeric membership. Any other value names nobody and never throws on
// a request; the owner's access and the claim requirement do not depend on it.
const adminListShapes: Array<[string, string, number[]]> = [
  ["a JSON string", '"93"', []],
  ["an array of strings", '["9"]', []],
  ["a scalar", "9", []],
  ["null", "null", []],
  ["an object", '{"9":true}', []],
  ["invalid JSON", "[9", []],
  ["an array with one bad entry", "[9, 1.5]", []],
  ["an empty list", "[]", []],
  ["an empty value", "", []],
  ["a valid numeric list", VALID_ADMIN_LIST, [ADMIN_UID]],
];

describe.each(adminListShapes)(
  "ADMIN_UIDS %s (%s) on the vote import",
  (_label, raw, administrators) => {
    beforeEach(() => {
      (Config as { adminUIDs: string }).adminUIDs = raw;
    });

    test.each([3, 9, 93])(
      "a claim holder with uid %p who owns nothing may import only if the list names it exactly",
      async (uid) => {
        const reply = await post({ uid, delphiEnabled: true });
        if (administrators.includes(uid)) {
          expect(reply).toEqual({ status: 200, body: PROCESSING, replies: 1 });
          expectImported(PLAIN_CSV);
        } else {
          expect(reply).toEqual({ status: 403, body: REFUSED, replies: 1 });
          expectOnlyTheOwnerRead();
          expectNothingImported();
        }
      }
    );

    test("the owner with the claim still imports", async () => {
      const reply = await post({ uid: OWNER_UID, delphiEnabled: true });
      expect(reply).toEqual({ status: 200, body: PROCESSING, replies: 1 });
      expectImported(PLAIN_CSV);
    });

    test("without the claim, owner and listed uid alike get today's reply", async () => {
      for (const uid of [OWNER_UID, ADMIN_UID]) {
        jest.clearAllMocks();
        const reply = await post({ uid, delphiEnabled: false });
        expect(reply.status).toBe(403);
        expect(reply.body).toEqual({
          error: "polis_err_votes_bulk_delphi_disabled",
          message: "polis_err_votes_bulk_delphi_disabled",
          status: 403,
        });
        expect(mockQuery).not.toHaveBeenCalled();
        expectNothingImported();
      }
    });
  }
);
