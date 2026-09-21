import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import crypto from "node:crypto";

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn(), queryP_readOnly: jest.fn() },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { loginCodePepper: "public-fixture-pepper" },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));
jest.mock("../../src/utils/fail", () => ({ failJson: jest.fn() }));
jest.mock("../../src/auth/generate-token", () => ({
  generateRandomCode: jest.fn(),
  generateLoginCode: jest.fn(),
}));
jest.mock("../../src/utils/zinvite", () => ({ getZinvite: jest.fn() }));
jest.mock("../../src/auth/anonymous-jwt", () => ({
  issueAnonymousJWT: jest.fn(),
}));
jest.mock("bcryptjs", () => ({
  __esModule: true,
  default: { compare: jest.fn(), hash: jest.fn() },
}));

import pg from "../../src/db/pg-query";
import bcrypt from "bcryptjs";
import { failJson } from "../../src/utils/fail";
import { getZinvite } from "../../src/utils/zinvite";
import { issueAnonymousJWT } from "../../src/auth/anonymous-jwt";
import { generateLoginCode } from "../../src/auth/generate-token";
import {
  handle_POST_treevite_login,
  handle_POST_treevite_acceptInvite,
  handle_GET_treevite_myInvites,
  handle_GET_treevite_me,
  handle_GET_treevite_myInvites_csv,
} from "../../src/invites/treevites";

const read = jest.mocked(pg.queryP_readOnly);
const write = jest.mocked(pg.queryP);
const compare = bcrypt.compare as jest.Mock;
const response = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    send: jest.fn(),
    setHeader: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res as any;
};

beforeEach(() => {
  jest.resetAllMocks();
  read.mockResolvedValue([]);
  write.mockResolvedValue([]);
  jest.mocked(getZinvite).mockResolvedValue("public-conversation");
  jest.mocked(issueAnonymousJWT).mockReturnValue("public-auth-token");
});

describe("tree invitation authentication boundaries", () => {
  test.each([
    { zid: undefined, login_code: "public-code" },
    { zid: 7, login_code: "   " },
  ])("invalid login input does not query or issue a token: %j", async (p) => {
    const res = response();
    await handle_POST_treevite_login({ p }, res);
    expect(failJson).toHaveBeenCalledWith(
      res,
      400,
      "polis_err_treevite_invalid_request"
    );
    expect(read).not.toHaveBeenCalled();
    expect(issueAnonymousJWT).not.toHaveBeenCalled();
  });

  test.each([
    { rows: [] },
    { rows: [{ pid: 0, revoked: true, login_code_hash: "fixture-hash" }] },
  ])(
    "missing or revoked credentials stop before hash verification: %j",
    async ({ rows }) => {
      read.mockResolvedValue(rows);
      const res = response();
      await handle_POST_treevite_login(
        { p: { zid: 7, login_code: "public-code" } },
        res
      );
      expect(failJson).toHaveBeenCalledWith(
        res,
        401,
        "polis_err_treevite_login_code_invalid"
      );
      expect(compare).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(issueAnonymousJWT).not.toHaveBeenCalled();
    }
  );

  test("a mismatching password hash never updates last use or issues a token", async () => {
    read.mockResolvedValue([
      { pid: 0, revoked: false, login_code_hash: "fixture-hash" },
    ]);
    compare.mockResolvedValue(false as never);
    const res = response();
    await handle_POST_treevite_login(
      { p: { zid: 7, login_code: "public-code" } },
      res
    );
    expect(compare).toHaveBeenCalledWith("public-code", "fixture-hash");
    expect(failJson).toHaveBeenCalledWith(
      res,
      401,
      "polis_err_treevite_login_code_invalid"
    );
    expect(write).not.toHaveBeenCalled();
    expect(issueAnonymousJWT).not.toHaveBeenCalled();
  });

  test("valid login trims the code, binds the conversation and preserves participant zero", async () => {
    read
      .mockResolvedValueOnce([
        { pid: 0, revoked: false, login_code_hash: "fixture-hash" },
      ])
      .mockResolvedValueOnce([{ uid: 12 }]);
    compare.mockResolvedValue(true as never);
    const res = response();
    await handle_POST_treevite_login(
      { p: { zid: 7, login_code: " public-code " } },
      res
    );
    const lookup = crypto
      .createHash("sha256")
      .update("public-codepublic-fixture-pepper")
      .digest("hex");
    expect(read.mock.calls[0][1]).toEqual([7, lookup]);
    expect(write.mock.calls[0][1]).toEqual([7, 0]);
    expect(read.mock.calls[1][1]).toEqual([7, 0]);
    expect(issueAnonymousJWT).toHaveBeenCalledWith(
      "public-conversation",
      12,
      0
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "ok",
      auth: {
        token: "public-auth-token",
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60,
      },
    });
  });

  test("failed last-use persistence prevents issuing a token", async () => {
    read.mockResolvedValue([
      { pid: 2, revoked: false, login_code_hash: "fixture-hash" },
    ]);
    compare.mockResolvedValue(true as never);
    const error = new Error("write unavailable");
    write.mockRejectedValue(error);
    const res = response();
    await handle_POST_treevite_login(
      { p: { zid: 7, login_code: "public-code" } },
      res
    );
    expect(failJson).toHaveBeenCalledWith(
      res,
      500,
      "polis_err_treevite_login_failed",
      error
    );
    expect(issueAnonymousJWT).not.toHaveBeenCalled();
  });

  test("an absent or already-used invite cannot create participant or login credentials", async () => {
    const res = response();
    await handle_POST_treevite_acceptInvite(
      { p: { zid: 7, invite_code: "used-code" } },
      res
    );
    expect(read.mock.calls[0][1]).toEqual([7, "used-code"]);
    expect(failJson).toHaveBeenCalledWith(
      res,
      400,
      "polis_err_treevite_invalid_or_used_invite"
    );
    expect(write).not.toHaveBeenCalled();
    expect(generateLoginCode).not.toHaveBeenCalled();
    expect(issueAnonymousJWT).not.toHaveBeenCalled();
  });

  test("losing the atomic invite claim does not mint credentials for an existing participant", async () => {
    read.mockResolvedValue([
      { id: 9, wave_id: 3, parent_invite_id: null, invite_used_by_pid: null },
    ]);
    const res = response();
    await handle_POST_treevite_acceptInvite(
      { p: { zid: 7, uid: 12, pid: 2, invite_code: " public-code " } },
      res
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain("and status = 0 returning id");
    expect(write.mock.calls[0][1]).toEqual([2, 9]);
    expect(failJson).toHaveBeenCalledWith(
      res,
      400,
      "polis_err_treevite_invite_race_condition"
    );
    expect(generateLoginCode).not.toHaveBeenCalled();
    expect(issueAnonymousJWT).not.toHaveBeenCalled();
  });
});

describe("tree invitation participant reads", () => {
  test.each([undefined, -1])(
    "nonparticipants get empty context without database reads: %s",
    async (pid) => {
      const res = response();
      await handle_GET_treevite_me({ p: { zid: 7, pid } }, res);
      expect(res.json).toHaveBeenCalledWith({
        participant: null,
        wave: null,
        invites: [],
      });
      expect(read).not.toHaveBeenCalled();
    }
  );

  test("participant zero remains a scoped invite owner", async () => {
    const rows = [{ id: 9, invite_code: "public-code", status: 0 }];
    read.mockResolvedValue(rows);
    const res = response();
    await handle_GET_treevite_myInvites({ p: { zid: 7, pid: 0 } }, res);
    expect(read.mock.calls[0][1]).toEqual([7, 0]);
    expect(read.mock.calls[0][0]).toContain("status = 0");
    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test("nonparticipants receive a header-only CSV without an invite query", async () => {
    const res = response();
    await handle_GET_treevite_myInvites_csv({ p: { zid: 7, pid: -1 } }, res);
    expect(read).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/csv; charset=utf-8"
    );
    expect(res.send).toHaveBeenCalledWith("invite_code,status,created_at\n");
  });
});
