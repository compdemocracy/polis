import { beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { adminUIDs: "[900]" },
}));
jest.mock("../../src/conversation", () => ({}));
jest.mock("../../src/user", () => ({ getUser: jest.fn() }));
jest.mock("../../src/xids", () => ({ getXidRecord: jest.fn() }));
jest.mock("../../src/db/pg-query", () => ({}));
jest.mock("../../src/db/sql", () => ({}));
jest.mock("../../src/invites/suzinvites", () => ({}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn() },
}));

import { getUser } from "../../src/user";
import { getXidRecord } from "../../src/xids";
import { handle_GET_users } from "../../src/routes/users";

const lookup = jest.mocked(getXidRecord);
const readUser = jest.mocked(getUser);
const ownerUid = 100;
const xidUid = 200;
const xid = "test-external-user";

async function requestUser(p: Record<string, unknown>) {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  await handle_GET_users({ p } as any, res as any);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  lookup.mockResolvedValue([{ uid: xidUid, owner: ownerUid, xid }] as any);
  readUser.mockResolvedValue({ uid: xidUid, email: "user@example.invalid" });
});

describe("GET users XID authorization", () => {
  test.each([
    ["owner", ownerUid],
    ["XID user", xidUid],
    ["configured administrator", 900],
  ])("allows the %s to read the XID record", async (_role, uid) => {
    const res = await requestUser({ uid, xid, owner_uid: ownerUid });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(readUser).toHaveBeenCalledWith(xidUid, null, xid, ownerUid);
    expect(res.json).toHaveBeenCalledWith({
      uid: xidUid,
      email: "user@example.invalid",
    });
  });

  test("refuses an unrelated user before reading the selected user's data", async () => {
    const res = await requestUser({ uid: 300, xid, owner_uid: ownerUid });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "polis_err_get_user_not_authorized",
      message: "polis_err_get_user_not_authorized",
      status: 403,
    });
    expect(readUser).not.toHaveBeenCalled();
  });

  test("keeps a request without XID scoped to the caller", async () => {
    const res = await requestUser({ uid: 300, owner_uid: ownerUid });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(readUser).toHaveBeenCalledWith(300, null, undefined, ownerUid);
  });

  test("keeps XID without an owner scoped to the caller", async () => {
    const res = await requestUser({ uid: 300, xid });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(readUser).toHaveBeenCalledWith(300, null, xid, undefined);
  });

  test("refuses an unrelated user when no XID record exists", async () => {
    lookup.mockResolvedValue([]);
    const res = await requestUser({ uid: 300, xid, owner_uid: ownerUid });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "polis_err_get_user_not_authorized",
      message: "polis_err_get_user_not_authorized",
      status: 403,
    });
    expect(readUser).not.toHaveBeenCalled();
  });

  test.each([
    ["owner", ownerUid],
    ["configured administrator", 900],
  ])(
    "reads only the %s's own data when no XID record exists",
    async (_role, uid) => {
      lookup.mockResolvedValue([]);
      readUser.mockResolvedValue({ uid, hasXid: false });
      const res = await requestUser({ uid, xid, owner_uid: ownerUid });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith(xid, undefined, ownerUid);
      expect(readUser).toHaveBeenCalledTimes(1);
      expect(readUser).toHaveBeenCalledWith(uid, null, undefined, undefined);
      expect(res.json).toHaveBeenCalledWith({ uid, hasXid: false });
    }
  );

  test.each([true, false])(
    "refuses a matching token XID from another user when record exists: %s",
    async (recordExists) => {
      if (!recordExists) lookup.mockResolvedValue([]);
      const res = await requestUser({
        uid: 300,
        xid,
        owner_uid: ownerUid,
        jwt_xid: xid,
      });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "polis_err_get_user_not_authorized",
        message: "polis_err_get_user_not_authorized",
        status: 403,
      });
      expect(readUser).not.toHaveBeenCalled();
    }
  );

  test.each([true, false])(
    "refuses a different token XID when record exists: %s",
    async (recordExists) => {
      if (!recordExists) lookup.mockResolvedValue([]);
      const res = await requestUser({
        uid: 300,
        xid,
        owner_uid: ownerUid,
        jwt_xid: "another-external-user",
      });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "polis_err_get_user_not_authorized",
        message: "polis_err_get_user_not_authorized",
        status: 403,
      });
      expect(readUser).not.toHaveBeenCalled();
    }
  );

  test("still requires authentication before looking up an XID", async () => {
    const res = await requestUser({ xid, owner_uid: ownerUid });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(lookup).not.toHaveBeenCalled();
    expect(readUser).not.toHaveBeenCalled();
  });

  test("does not read user data if the XID lookup fails", async () => {
    lookup.mockRejectedValueOnce(new Error("lookup unavailable"));
    const res = await requestUser({ uid: ownerUid, xid, owner_uid: ownerUid });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(readUser).not.toHaveBeenCalled();
  });
});
