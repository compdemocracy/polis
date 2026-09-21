import { beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../../src/auth", () => ({ generateTokenP: jest.fn() }));
jest.mock("../../src/email/senders", () => ({ sendTextEmail: jest.fn() }));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    polisFromAddress: "sender@example.invalid",
    getServerNameWithProtocol: () => "https://polis.example.invalid",
  },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn() },
}));
jest.mock("../../src/utils/fail", () => ({ failJson: jest.fn() }));

import { generateTokenP } from "../../src/auth";
import { sendTextEmail } from "../../src/email/senders";
import pg from "../../src/db/pg-query";
import { failJson } from "../../src/utils/fail";
import { doSendEinvite } from "../../src/invites/einvites";
import {
  handle_GET_einvites,
  handle_POST_einvites,
} from "../../src/invites/routes";

const token = jest.mocked(generateTokenP);
const query = jest.mocked(pg.queryP);
const send = jest.mocked(sendTextEmail);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as any;
};

beforeEach(() => {
  jest.resetAllMocks();
  token.mockResolvedValue("public-invite-token" as never);
  query.mockResolvedValue([]);
  send.mockResolvedValue({ $metadata: {} });
});

describe("email invitation delivery boundary", () => {
  test("persists the generated token before sending the matching welcome URL", async () => {
    let release!: () => void;
    query.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }) as never
    );
    const pending = doSendEinvite({}, "reader@example.invalid");
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(query.mock.calls[0][1]).toEqual([
      "reader@example.invalid",
      "public-invite-token",
    ]);
    release();
    await pending;
    expect(token).toHaveBeenCalledWith(30, false);
    expect(send).toHaveBeenCalledWith(
      "sender@example.invalid",
      "reader@example.invalid",
      "Get Started with Polis",
      expect.stringContaining(
        "https://polis.example.invalid/welcome/public-invite-token"
      )
    );
  });

  test("a token-generation failure neither persists nor sends an invitation", async () => {
    const error = new Error("token unavailable");
    token.mockRejectedValue(error as never);
    await expect(doSendEinvite({}, "reader@example.invalid")).rejects.toBe(
      error
    );
    expect(query).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test("a database failure prevents delivery and preserves the original error", async () => {
    const error = new Error("insert refused");
    query.mockRejectedValue(error);
    await expect(doSendEinvite({}, "reader@example.invalid")).rejects.toBe(
      error
    );
    expect(send).not.toHaveBeenCalled();
  });

  test("the POST route acknowledges only completed delivery", async () => {
    const res = response();
    handle_POST_einvites({ p: { email: "reader@example.invalid" } }, res);
    await flush();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({});
    expect(failJson).not.toHaveBeenCalled();
  });

  test("the POST route reports provider failure without a success response", async () => {
    const error = new Error("mail unavailable");
    send.mockRejectedValue(error);
    const res = response();
    handle_POST_einvites({ p: { email: "reader@example.invalid" } }, res);
    await flush();
    expect(failJson).toHaveBeenCalledWith(
      res,
      500,
      "polis_err_sending_einvite",
      error
    );
    expect(res.json).not.toHaveBeenCalled();
  });

  test("lookup binds the supplied token and returns its invitation", async () => {
    const row = {
      einvite: "public-invite-token",
      email: "reader@example.invalid",
    };
    query.mockResolvedValue([row]);
    const res = response();
    handle_GET_einvites({ p: { einvite: row.einvite } }, res);
    await flush();
    expect(query.mock.calls[0][1]).toEqual([row.einvite]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(row);
  });

  test("missing invitations fail instead of returning an empty success", async () => {
    const res = response();
    handle_GET_einvites({ p: { einvite: "missing-public-token" } }, res);
    await flush();
    expect(failJson).toHaveBeenCalledWith(
      res,
      500,
      "polis_err_fetching_einvite",
      expect.objectContaining({ message: "polis_err_missing_einvite" })
    );
    expect(res.json).not.toHaveBeenCalled();
  });
});
