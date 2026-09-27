import { beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../../src/auth", () => ({ generateToken: jest.fn() }));
jest.mock("../../src/email/senders", () => ({ sendTextEmail: jest.fn() }));
jest.mock("../../src/utils/common", () => ({ escapeLiteral: jest.fn() }));
jest.mock("../../src/utils/zinvite", () => ({ getZinvite: jest.fn() }));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    polisFromAddress: "sender@example.invalid",
    getServerNameWithProtocol: () => "https://polis.example.invalid",
  },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn(), query: jest.fn() },
}));

import { generateToken } from "../../src/auth";
import { sendTextEmail } from "../../src/email/senders";
import { getZinvite } from "../../src/utils/zinvite";
import pg from "../../src/db/pg-query";
import {
  checkSuzinviteCodeValidity,
  createOneSuzinvite,
  sendSuzinviteEmail,
} from "../../src/invites/suzinvites";

beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(generateToken)
    .mockImplementation((_n, _random, callback) =>
      callback(null, "x".repeat(31))
    );
  jest.mocked(pg.queryP).mockResolvedValue([]);
  jest.mocked(getZinvite).mockResolvedValue("public-conversation");
});

describe("single-use invitation boundaries", () => {
  test.each([
    { error: new Error("lookup unavailable"), result: undefined, expected: 1 },
    { error: null, result: { rows: [] }, expected: 1 },
    {
      error: null,
      result: { rows: [{ suzinvite: "public-code" }] },
      expected: null,
    },
  ])(
    "validity uses a conversation-scoped database result: %j",
    ({ error, result, expected }) => {
      (pg.query as jest.Mock).mockImplementation(
        (_sql, _values, callback: any) => callback(error, result)
      );
      const callback = jest.fn();
      checkSuzinviteCodeValidity(7, "public-code", callback);
      expect(pg.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE zid = ($1) AND suzinvite = ($2)"),
        [7, "public-code"],
        expect.any(Function)
      );
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expected);
    }
  );

  test("creation binds generated code to external identity, conversation and owner before URL generation", async () => {
    const url = jest.fn((conversation, code) => `${conversation}/${code}`);
    const result = await createOneSuzinvite("public-external-id", 7, 12, url);
    const values = jest.mocked(pg.queryP).mock.calls[0][1] as unknown[];
    expect(values.slice(1)).toEqual(["public-external-id", 7, 12]);
    expect(values[0]).toMatch(/^[2-9]x{31}$/);
    expect(getZinvite).toHaveBeenCalledWith(7);
    expect(url).toHaveBeenCalledWith("public-conversation", values[0]);
    expect(result).toEqual({
      zid: 7,
      conversation_id: "public-conversation",
      suurl: `public-conversation/${values[0]}`,
    });
  });

  test("token-generation failure cannot persist or expose a URL", async () => {
    jest
      .mocked(generateToken)
      .mockImplementation((_n, _random, callback) =>
        callback(new Error("entropy unavailable"))
      );
    const url = jest.fn();
    await expect(
      createOneSuzinvite("public-external-id", 7, 12, url)
    ).rejects.toThrow("polis_err_creating_otzinvite");
    expect(pg.queryP).not.toHaveBeenCalled();
    expect(getZinvite).not.toHaveBeenCalled();
    expect(url).not.toHaveBeenCalled();
  });

  test("insert failure cannot expose a URL for an unpersisted invitation", async () => {
    const error = new Error("insert refused");
    jest.mocked(pg.queryP).mockRejectedValue(error);
    const url = jest.fn();
    await expect(
      createOneSuzinvite("public-external-id", 7, 12, url)
    ).rejects.toBe(error);
    expect(getZinvite).not.toHaveBeenCalled();
    expect(url).not.toHaveBeenCalled();
  });

  test("email includes the conversation and invitation in its single-use URL", async () => {
    await sendSuzinviteEmail(
      {} as any,
      "reader@example.invalid",
      "public-conversation",
      "public-code"
    );
    expect(sendTextEmail).toHaveBeenCalledWith(
      "sender@example.invalid",
      "reader@example.invalid",
      "Join the pol.is conversation!",
      expect.stringContaining(
        "https://polis.example.invalid/ot/public-conversation/public-code"
      )
    );
  });
});
