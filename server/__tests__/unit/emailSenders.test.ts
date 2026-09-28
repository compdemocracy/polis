import { beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  SendEmailCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { awsRegion: "us-east-1" },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn() },
}));

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import logger from "../../src/utils/logger";
import Config from "../../src/config";
import {
  sendTextEmail,
  sendMultipleTextEmails,
  emailTeam,
} from "../../src/email/senders";

const client = jest.mocked(SESv2Client).mock.results[0].value as {
  send: jest.Mock;
};
const send = client.send as jest.Mock;

beforeEach(() => {
  Config.adminEmails = undefined;
  Config.polisFromAddress = "sender@example.invalid";
  send.mockReset();
  jest.mocked(SendEmailCommand).mockClear();
  jest.mocked(logger.error).mockClear();
});

describe("email provider boundary", () => {
  test("single delivery carries its sender, recipient and both body formats", async () => {
    const receipt = { MessageId: "public-provider-receipt" };
    send.mockResolvedValue(receipt as never);
    await expect(
      sendTextEmail(
        "sender@example.invalid",
        "reader@example.invalid",
        "Public subject",
        "Public body"
      )
    ).resolves.toBe(receipt);
    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        FromEmailAddress: "sender@example.invalid",
        Destination: { ToAddresses: ["reader@example.invalid"] },
        Content: {
          Simple: {
            Subject: { Charset: "UTF-8", Data: "Public subject" },
            Body: {
              Html: {
                Charset: "UTF-8",
                Data: expect.stringContaining("Public body"),
              },
              Text: {
                Charset: "UTF-8",
                Data: expect.stringContaining("Public body"),
              },
            },
          },
        },
      })
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("single delivery preserves a rejected provider error", async () => {
    const error = new Error("public provider refusal");
    send.mockRejectedValue(error as never);
    await expect(
      sendTextEmail(
        "sender@example.invalid",
        "reader@example.invalid",
        "Subject",
        "Body"
      )
    ).rejects.toBe(error);
  });

  test("a failed recipient does not suppress other deliveries and results retain input order", async () => {
    const error = new Error("middle recipient refused");
    send
      .mockResolvedValueOnce({ MessageId: "first" } as never)
      .mockRejectedValueOnce(error as never)
      .mockResolvedValueOnce({ MessageId: "third" } as never);
    const results = await sendMultipleTextEmails(
      "sender@example.invalid",
      [
        "first@example.invalid",
        "second@example.invalid",
        "third@example.invalid",
      ],
      "Subject",
      "Body"
    );
    expect(results).toEqual([
      { status: "fulfilled", value: { MessageId: "first" } },
      { status: "rejected", reason: error },
      { status: "fulfilled", value: { MessageId: "third" } },
    ]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "polis_err_failed_to_email_user_definitively",
      expect.objectContaining({ recipient: "second@example.invalid" })
    );
  });

  test("an empty recipient list performs no provider operation", async () => {
    await expect(
      sendMultipleTextEmails("sender@example.invalid", [], "Subject", "Body")
    ).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("team notification configuration", () => {
  test("malformed admin configuration logs a refusal without delivery", async () => {
    Config.adminEmails = "invalid-json";
    await emailTeam("Subject", "Body");
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "polis_err_email_config_parse_failure",
      expect.any(Object)
    );
  });

  test("missing sender prevents delivery even with a configured recipient", async () => {
    Config.adminEmails = '["admin@example.invalid"]';
    Config.polisFromAddress = undefined;
    await emailTeam("Subject", "Body");
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "polis_err_email_config_missing_sender",
      expect.any(Object)
    );
  });

  test("configured team recipients receive separate deliveries", async () => {
    Config.adminEmails = '["one@example.invalid","two@example.invalid"]';
    send.mockResolvedValue({} as never);
    await emailTeam("Subject", "Body");
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      jest
        .mocked(SendEmailCommand)
        .mock.calls.map(([input]) => input.Destination?.ToAddresses)
    ).toEqual([["one@example.invalid"], ["two@example.invalid"]]);
  });
});
