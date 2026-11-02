/** Unit tests of identity scoping before any admission lookup or write. */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import type { Response } from "express";
import type { RequestWithP } from "../../src/d";
import { ensureParticipant } from "../../src/auth/ensure-participant";
import {
  createExtractUserMiddleware,
  createJwtValidation,
  issueParticipantJWT,
} from "../../src/auth/jwt-utils";
import { getConversationInfo } from "../../src/conversation";
import { getXidRecord, isXidAllowed } from "../../src/xids";
import { addParticipantAndMetadata } from "../../src/participant";

jest.mock("../../src/config", () => {
  const { generateKeyPairSync } =
    jest.requireActual<typeof import("node:crypto")>("node:crypto");
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    __esModule: true,
    default: {
      jwtPrivateKey: keys.privateKey,
      jwtPublicKey: keys.publicKey,
      polisJwtIssuer: "https://issuer.example.invalid/",
      polisJwtAudience: "participants",
    },
  };
});
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
jest.mock("../../src/auth/create-user", () => ({}));
jest.mock("../../src/user", () => ({}));
jest.mock("../../src/utils/zinvite", () => ({}));
jest.mock("../../src/utils/common", () => ({}));
jest.mock("../../src/utils/fail", () => ({}));
jest.mock("../../src/db/pg-query", () => ({}));

interface Case {
  name: string;
  token?: "anonymous" | "xid";
  conversation: string;
  request_xid: string | null;
  uid: number | null;
  pid: number | null;
  xid: string;
}
const cases: Case[] = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../queue-rs/polis-auth/tests/fixtures/xid-request-identity.json"
    ),
    "utf8"
  )
);

cases.push({
  name: "anonymous token in another conversation uses the request xid",
  token: "anonymous",
  conversation: "2another",
  request_xid: "request-xid",
  uid: null,
  pid: null,
  xid: "request-xid",
});

describe("XID request identity before admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Stop at the admission boundary; this test neither reads the allow-list
    // nor resolves or creates any participant. Inspect the scoped request.
    jest
      .mocked(getConversationInfo)
      .mockRejectedValue(new Error("polis_err_test_identity_boundary"));
  });

  test.each(cases)("$name", async (row) => {
    const kind = row.token ?? "xid";
    const token =
      kind === "anonymous"
        ? issueParticipantJWT("anonymous", "2fixture", 3, 0)
        : issueParticipantJWT("xid", "2fixture", 3, 0, "fixture-xid");
    const req = {
      headers: { authorization: `Bearer ${token}` },
      body: { conversation_id: row.conversation },
      query: {},
      p: {},
    } as unknown as RequestWithP;
    const res = {} as Response;
    await new Promise<void>((resolve, reject) => {
      void createJwtValidation("testPayload")(req, res, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const extracted = jest.fn();
    await createExtractUserMiddleware(
      kind,
      "testPayload",
      (request, key, value) => {
        request.p[key] = value;
      }
    )(req, res, extracted);
    expect(extracted).toHaveBeenCalledWith();

    // Simulate route parameter parsing after token extraction.
    req.p.zid = row.conversation === "2fixture" ? 1 : 2;
    req.p.conversation_id = row.conversation;
    if (row.request_xid !== null) req.p.xid = row.request_xid;
    const next = jest.fn();
    await ensureParticipant({ createIfMissing: false, issueJWT: false })(
      req,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      new Error("polis_err_test_identity_boundary")
    );
    expect(req.p.uid ?? null).toBe(row.uid);
    expect(req.p.pid ?? null).toBe(row.pid);
    expect(req.p.xid).toBe(row.xid);
    expect(
      req.p.xid !== undefined &&
        (req.p.uid === undefined || req.p.xid_participant)
    ).toBe(true);
    expect(getConversationInfo).toHaveBeenCalledWith(req.p.zid);
    expect(isXidAllowed).not.toHaveBeenCalled();
    expect(getXidRecord).not.toHaveBeenCalled();
    expect(addParticipantAndMetadata).not.toHaveBeenCalled();
  });
});
