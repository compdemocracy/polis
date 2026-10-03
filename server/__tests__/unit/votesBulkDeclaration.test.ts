/**
 * POST /api/v3/votes-bulk refuses a malformed or mismatched declared vote sign
 * before anything is stored or enqueued (P-078 PR-E; docs/export-format.md).
 * Absent a declaration the request goes through exactly as before.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const s3Send = jest.fn();
const sqsSend = jest.fn();
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: s3Send })),
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
  sqsClient: { send: (...a: unknown[]) => sqsSend(...a) },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn(), queryP_readOnly: jest.fn() },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  },
}));
jest.mock("../../src/utils/fail", () => ({ failJson: jest.fn() }));
jest.mock("../../src/server-helpers", () => ({}));
jest.mock("../../src/nextComment", () => ({}));
jest.mock("../../src/user", () => ({}));

import pg from "../../src/db/pg-query";
import { failJson } from "../../src/utils/fail";
import { handle_POST_votes_bulk } from "../../src/routes/votes";
import {
  VOTE_DECLARATION_ERRORS,
  EXPORT_VOTE_CONVENTION,
} from "../../src/votes/convention";
import { exportFormatDocument } from "../../src/votes/exportFormat";

const fixture = (name: string) =>
  readFileSync(
    join(__dirname, "..", "fixtures", "vote-declaration", name),
    "utf8"
  );
const declarations = JSON.parse(fixture("declarations.json")) as {
  documents: { doc: unknown; outcome: string }[];
};
const undeclared = (text: string) => text.slice(text.indexOf("\n") + 1);

function post(body: Record<string, unknown>) {
  const res = { json: jest.fn() };
  const req = {
    p: { zid: 7, uid: 3, delphiEnabled: true },
    body,
  };
  return { res, done: handle_POST_votes_bulk(req as any, res as any) };
}

beforeEach(() => {
  jest.clearAllMocks();
  (pg.queryP_readOnly as jest.Mock).mockResolvedValue([
    { "?column?": 1 },
  ] as never);
  (pg.queryP as jest.Mock).mockImplementation((async (sql: string) =>
    String(sql).includes("RETURNING id")
      ? [{ id: 11 }]
      : [{ email: "" }]) as never);
  s3Send.mockResolvedValue({} as never);
  sqsSend.mockResolvedValue({} as never);
});

function stored(): string | undefined {
  const command = s3Send.mock.calls[0]?.[0] as { input: { Body: string } };
  return command?.input.Body;
}

describe("votes-bulk declared sign", () => {
  test("absent: accepted and stored byte for byte, as before", async () => {
    const csv = undeclared(fixture("import-declared.csv"));
    const { res, done } = post({ csv });
    await done;
    expect(failJson).not.toHaveBeenCalled();
    expect(stored()).toBe(csv);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing" })
    );
  });

  test("present in the file and matching: accepted, stored as sent for the worker to read", async () => {
    const csv = fixture("import-declared.csv");
    const { res, done } = post({ csv });
    await done;
    expect(failJson).not.toHaveBeenCalled();
    expect(stored()).toBe(csv);
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  test("present beside the file (format.json's shape) and matching: accepted", async () => {
    const csv = undeclared(fixture("import-declared.csv"));
    for (const format of [
      exportFormatDocument(),
      JSON.stringify(exportFormatDocument()),
      { "vote-convention": EXPORT_VOTE_CONVENTION },
    ]) {
      jest.clearAllMocks();
      const { res, done } = post({ csv, format });
      await done;
      expect(failJson).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledTimes(1);
    }
  });

  test.each([
    ["import-mismatch-sign.csv", VOTE_DECLARATION_ERRORS.mismatch],
    ["import-mismatch-format.csv", VOTE_DECLARATION_ERRORS.mismatch],
    ["import-malformed.csv", VOTE_DECLARATION_ERRORS.malformed],
  ])(
    "%s in the file: 400 %s, nothing stored or enqueued",
    async (file, code) => {
      const { res, done } = post({ csv: fixture(file) });
      await done;
      expect(failJson).toHaveBeenCalledWith(res, 400, code, expect.anything());
      expect(s3Send).not.toHaveBeenCalled();
      expect(sqsSend).not.toHaveBeenCalled();
      expect(pg.queryP).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    }
  );

  test.each(
    declarations.documents
      .filter((d) => d.outcome !== "accepted")
      .map((d) => [JSON.stringify(d.doc), d.doc, d.outcome] as const)
  )("format beside the file %s: refused", async (_, format, outcome) => {
    const csv = undeclared(fixture("import-declared.csv"));
    const { res, done } = post({ csv, format });
    await done;
    expect(failJson).toHaveBeenCalledWith(
      res,
      400,
      outcome === "mismatch"
        ? VOTE_DECLARATION_ERRORS.mismatch
        : VOTE_DECLARATION_ERRORS.malformed,
      expect.anything()
    );
    expect(s3Send).not.toHaveBeenCalled();
  });
});
