/**
 * The vote CSV import (POST /api/v3/votes-bulk) still reads the
 * delphi_enabled claim directly, under every value of
 * POLIS_DELPHI_ENTITLEMENT: it is the one Polis 2 route that does not ask
 * routes/delphi/entitlement.ts, and it never reads delphi_entitlements. A
 * change to that handler waits for its own ruling; until then this holds.
 *
 * No request here carries a CSV: every one is answered before a CSV would be
 * read, so no vote value is involved.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const ZID = 7;
const OWNER_UID = 1;
const OTHER_UID = 3;

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<any>>();
const mockQueryReadOnly =
  jest.fn<(sql: string, params?: unknown[]) => Promise<any>>();
const mockS3Send = jest.fn<(command: any) => Promise<any>>();
const mockSqsSend = jest.fn<(command: any) => Promise<any>>();

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
    adminUIDs: "[]",
  },
}));
jest.mock("../../src/server-helpers", () => ({}));
jest.mock("../../src/nextComment", () => ({}));
jest.mock("../../src/user", () => ({}));

import Config from "../../src/config";
import { handle_POST_votes_bulk } from "../../src/routes/votes";

async function post(p: Record<string, unknown>) {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  await handle_POST_votes_bulk({ p: { zid: ZID, ...p }, body: {} } as any, res);
  return { status: res.statusCode, body: res.body };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT owner FROM conversations"))
      return [{ owner: OWNER_UID }];
    throw new Error(`unexpected query: ${sql}`);
  });
  mockQueryReadOnly.mockRejectedValue(new Error("no replica read expected"));
});

describe.each(["claim", "claim_or_db", "db"])(
  "POLIS_DELPHI_ENTITLEMENT=%s",
  (source) => {
    beforeEach(() => {
      (Config as { delphiEntitlement: string }).delphiEntitlement = source;
    });

    test("an account without the claim is refused as before, and nothing is read", async () => {
      const reply = await post({ uid: OTHER_UID, delphiEnabled: false });
      expect(reply).toEqual({
        status: 403,
        body: {
          error: "polis_err_votes_bulk_delphi_disabled",
          message: "polis_err_votes_bulk_delphi_disabled",
          status: 403,
        },
      });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockQueryReadOnly).not.toHaveBeenCalled();
    });

    test("a claim holder reaches the owner check without any entitlement read", async () => {
      const reply = await post({ uid: OTHER_UID, delphiEnabled: true });
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe(
        "polis_err_votes_bulk_not_conversation_owner"
      );
      expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual([
        "SELECT owner FROM conversations WHERE zid = ($1);",
      ]);
      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockSqsSend).not.toHaveBeenCalled();
    });
  }
);
