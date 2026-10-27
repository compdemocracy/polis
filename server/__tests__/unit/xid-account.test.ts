import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import pg from "../../src/db/pg-query";
import { isPolisDev } from "../../src/utils/common";
import logger from "../../src/utils/logger";
import {
  classifyXidAccount,
  isXidAccountError,
  requireXidParticipantAccount,
  respondToXidAccountError,
} from "../../src/auth/xid-account";

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn() },
}));
jest.mock("../../src/utils/common", () => ({ isPolisDev: jest.fn() }));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn() },
}));

const plain = {
  owns_conversation: false,
  is_owner: false,
  site_moderator: false,
  oidc_mapped: false,
};

describe("XID account classification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isPolisDev).mockReturnValue(false);
    jest.mocked(pg.queryP).mockResolvedValue([plain]);
  });

  test.each([
    ["owns_conversation", "conversation_owner"],
    ["is_owner", "owner_flag"],
    ["site_moderator", "site_moderator"],
    ["oidc_mapped", "oidc_mapped"],
  ])("refuses %s with a countable, identity-free event", async (flag, kind) => {
    const account = { ...plain, [flag]: true };
    expect(classifyXidAccount(account, false)).toBe(kind);
    jest.mocked(pg.queryP).mockResolvedValue([account]);
    const error = await requireXidParticipantAccount(123).catch((e) => e);
    expect(isXidAccountError(error)).toBe(true);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    respondToXidAccountError(res as any, error);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "polis_err_xid_owner_account",
      message: "polis_err_xid_owner_account",
      status: 403,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("polis_err_xid_owner_account", {
      account_class: kind,
    });
  });

  test("refuses an ADMIN_UIDS account even without a database row", async () => {
    expect(classifyXidAccount(plain, true)).toBe("admin");
    jest.mocked(isPolisDev).mockReturnValue(true);
    await expect(requireXidParticipantAccount(123)).rejects.toThrow(
      "polis_err_xid_owner_account"
    );
    expect(isPolisDev).toHaveBeenCalledWith(123);
    expect(pg.queryP).not.toHaveBeenCalled();
  });

  test("admits a plain participant", async () => {
    expect(classifyXidAccount(plain, false)).toBeUndefined();
    await expect(requireXidParticipantAccount(123)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("fails closed when the account check fails", async () => {
    jest.mocked(pg.queryP).mockRejectedValue(new Error("database unavailable"));
    const error = await requireXidParticipantAccount(123).catch((e) => e);
    expect(isXidAccountError(error)).toBe(true);
    expect(error.status).toBe(500);
  });

  test("leaves tokens for a missing, unprivileged account to existing handlers", async () => {
    jest.mocked(pg.queryP).mockResolvedValue([]);
    await expect(requireXidParticipantAccount(123)).resolves.toBeUndefined();
  });
});
