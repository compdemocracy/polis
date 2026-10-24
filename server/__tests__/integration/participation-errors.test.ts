import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { randomBytes, randomUUID } from "crypto";
import type { Express } from "express";
import request from "supertest";
import { getApp } from "../app-loader";
import { pool } from "../setup/db-test-helpers";
import { issueParticipantJWT } from "../../src/auth/jwt-utils";
import Config from "../../src/config";
import pg from "../../src/db/pg-query";

const missingCode = "polis_err_fetching_zid_for_conversation_id";
const parseCode = "polis_err_param_parse_failed_conversation_id";
const summaryBytes = '{"0":{"votes":0,"comments":1}}';

describe("participation conversation errors", () => {
  let app: Express;
  let owner: number;
  let stranger: number;
  let token: string;
  let strangerToken: string;
  const zids: number[] = [];
  const conversationId = `2${randomBytes(5).toString("hex").slice(0, 9)}`;
  const shortId = `3${randomBytes(3).toString("hex").slice(0, 5)}`;
  const unknownId = `4${randomBytes(5).toString("hex").slice(0, 9)}`;

  async function createConversation(id: string) {
    const { rows } = await pool.query(
      "INSERT INTO conversations (owner, is_active) VALUES ($1, TRUE) RETURNING zid",
      [owner]
    );
    const zid = rows[0].zid;
    zids.push(zid);
    await pool.query("INSERT INTO zinvites (zid, zinvite) VALUES ($1, $2)", [zid, id]);
    return zid;
  }

  beforeAll(async () => {
    app = await getApp();
    const { rows } = await pool.query(
      "INSERT INTO users (email) VALUES ($1), ($2) RETURNING uid",
      [`owner-${randomUUID()}@example.invalid`, `stranger-${randomUUID()}@example.invalid`]
    );
    [owner, stranger] = rows.map((row) => row.uid);
    token = issueParticipantJWT("standard_user", conversationId, owner, 0, "owner");
    strangerToken = issueParticipantJWT("standard_user", conversationId, stranger, 0, "stranger");
    const zid = await createConversation(conversationId);
    await createConversation(shortId);
    const participant = await pool.query(
      "INSERT INTO participants (zid, uid) VALUES ($1, $2) RETURNING pid",
      [zid, owner]
    );
    expect(participant.rows[0].pid).toBe(0);
    await pool.query(
      "INSERT INTO comments (zid, tid, pid, uid, txt) VALUES ($1, 0, 0, $2, $3)",
      [zid, owner, "A comment for the participation summary"]
    );
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await pool.query("DELETE FROM comments WHERE zid = ANY($1)", [zids]);
    await pool.query("DELETE FROM participants WHERE zid = ANY($1)", [zids]);
    await pool.query("DELETE FROM zinvites WHERE zid = ANY($1)", [zids]);
    await pool.query("DELETE FROM conversations WHERE zid = ANY($1)", [zids]);
    await pool.query("DELETE FROM users WHERE uid = ANY($1)", [[owner, stranger]]);
  });

  function visit(query: Record<string, unknown>, auth: string | null = token) {
    const req = request(app).get("/api/v3/participation").query(query);
    return auth === null ? req : req.set("Authorization", `Bearer ${auth}`);
  }

  function errorBody(code: string, status: number) {
    return { error: code, message: code, status };
  }

  function expectLegacyParameterError(
    response: request.Response,
    error = missingCode,
    name = "conversation_id",
    value = unknownId
  ) {
    if (Config.reachableErrorHandler) {
      expect(response.status).toBe(500);
      expect(response.text).toBe(JSON.stringify({
        error: "internal_server_error",
        message: "An unexpected error occurred. Please try again.",
      }));
    } else {
      expect(response.status).toBe(400);
      expect(response.text).toBe(
        `polis_err_param_parse_failed_${name} (val=&#39;${value}&#39;, error=${error})\n`
      );
    }
  }

  async function ownedRows() {
    const { rows } = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM conversations WHERE owner = $1) AS conversations,
        (SELECT count(*)::int FROM zinvites WHERE zinvite = $2 OR zid = ANY($3)) AS invites,
        (SELECT count(*)::int FROM participants WHERE zid = ANY($3)) AS participants,
        (SELECT count(*)::int FROM comments WHERE zid = ANY($3)) AS comments,
        (SELECT count(*)::int FROM votes WHERE zid = ANY($3)) AS votes`,
      [owner, unknownId, zids]
    );
    return rows[0];
  }

  test("an unknown well-formed id answers 404 without writes or aggregation", async () => {
    const before = await ownedRows();
    const writes = jest.spyOn(pg, "query");
    const promiseWrites = jest.spyOn(pg, "queryP");
    const aggregates = jest.spyOn(pg, "queryP_reportExport");
    const response = await visit({ conversation_id: unknownId });
    expect(await ownedRows()).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    expect(promiseWrites).not.toHaveBeenCalled();
    expect(aggregates).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(response.body).toEqual(errorBody(missingCode, 404));
  });

  test.each([
    ["overlong", "a".repeat(101)],
    ["array", ["first", "second"]],
    ["object", { value: "first" }],
    ["empty", ""],
    ["whitespace", " \t "],
  ])("a %s id answers the existing parse code with 400", async (_label, value) => {
    const lookup = jest.spyOn(pg, "query_readOnly");
    const response = await visit({ conversation_id: value });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(errorBody(parseCode, 400));
    expect(lookup).not.toHaveBeenCalled();
  });

  test("a missing id answers the existing missing code with 400", async () => {
    const response = await visit({});
    expect(response.status).toBe(400);
    expect(response.body).toEqual(errorBody("polis_err_param_missing_conversation_id", 400));
  });

  test("the owner's populated summary preserves the baseline response bytes", async () => {
    const response = await visit({ conversation_id: conversationId });
    expect(response.status).toBe(200);
    expect(response.text).toBe(summaryBytes);
  });

  test("six-character ids and empty summaries preserve the baseline response bytes", async () => {
    const response = await visit({ conversation_id: shortId });
    expect(response.status).toBe(200);
    expect(response.text).toBe("{}");
  });

  test("closed conversations retain owner access and the baseline response bytes", async () => {
    await pool.query("UPDATE conversations SET is_active = FALSE WHERE zid = $1", [zids[0]]);
    try {
      const response = await visit({ conversation_id: conversationId });
      expect(response.status).toBe(200);
      expect(response.text).toBe(summaryBytes);
    } finally {
      await pool.query("UPDATE conversations SET is_active = TRUE WHERE zid = $1", [zids[0]]);
    }
  });

  test("strict mode retains its 409 response bytes", async () => {
    const response = await visit({ conversation_id: conversationId, strict: true });
    expect(response.status).toBe(409);
    expect(response.text).toBe(JSON.stringify(errorBody(
      "polis_err_get_participation_missing_xids This conversation has no xids for its participants.",
      409
    )));
  });

  test("an authenticated non-owner retains the 403 response bytes", async () => {
    const response = await visit({ conversation_id: conversationId }, strangerToken);
    expect(response.status).toBe(403);
    expect(response.text).toBe(JSON.stringify(errorBody("polis_err_get_participation_auth", 403)));
  });

  test.each([
    ["missing", null, "No authentication token found"],
    ["invalid", "invalid-token", "Invalid token format"],
  ])("%s auth retains the 401 response bytes before lookup", async (_label, auth, error) => {
    const lookup = jest.spyOn(pg, "query_readOnly");
    const response = await visit({ conversation_id: unknownId }, auth);
    expect(response.status).toBe(401);
    expect(response.text).toBe(JSON.stringify(auth === null ? { error } : {
      error,
      details: "Token does not match any supported JWT type",
    }));
    expect(lookup).not.toHaveBeenCalled();
  });

  test("a removed conversation with a cached id answers 404 without aggregation", async () => {
    const id = `5${randomBytes(5).toString("hex").slice(0, 9)}`;
    const zid = await createConversation(id);
    const before = await visit({ conversation_id: id });
    expect(before.status).toBe(200);
    expect(before.text).toBe("{}");
    await pool.query("DELETE FROM zinvites WHERE zid = $1", [zid]);
    await pool.query("DELETE FROM conversations WHERE zid = $1", [zid]);
    const aggregates = jest.spyOn(pg, "queryP_reportExport");
    const response = await visit({ conversation_id: id });
    expect(aggregates).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(response.body).toEqual(errorBody(missingCode, 404));
  });

  test("a lookup service Error with the missing-row message retains the baseline response", async () => {
    const read = pg.query_readOnly.bind(pg);
    jest.spyOn(pg, "query_readOnly").mockImplementation((sql, params, callback) => {
      if (String(sql).startsWith("select zid from zinvites")) {
        callback(new Error(missingCode), undefined);
        return;
      }
      return read(sql, params, callback);
    });
    const response = await visit({ conversation_id: unknownId });
    expectLegacyParameterError(response, `Error: ${missingCode}`);
  });

  test.each(["/api/v3/participants", "/api/v3/comments"])(
    "%s retains its existing lookup-error status and bytes",
    async (path) => {
      const response = await request(app).get(path)
        .set("Authorization", `Bearer ${token}`)
        .query({ conversation_id: unknownId });
      expectLegacyParameterError(response);
    }
  );

  test("an invalid strict parameter retains its existing status and bytes", async () => {
    const response = await visit({ conversation_id: conversationId, strict: "invalid" });
    expectLegacyParameterError(response, "polis_fail_parse_boolean", "strict", "invalid");
  });

  test("an owner lookup service failure retains its 500 response bytes", async () => {
    const query = pg.query.bind(pg);
    jest.spyOn(pg, "query").mockImplementation((sql, params, callback) => {
      if (String(sql).startsWith("SELECT * FROM conversations WHERE zid")) {
        callback(new Error("owner lookup unavailable"), undefined);
        return;
      }
      return query(sql, params, callback);
    });
    const response = await visit({ conversation_id: conversationId });
    expect(response.status).toBe(500);
    expect(response.text).toBe(JSON.stringify(errorBody("polis_err_get_participation_misc", 500)));
  });

  test("a report pool acquire timeout retains its 503 response bytes", async () => {
    jest.spyOn(pg, "queryP_reportExport").mockRejectedValue(
      new Error("timeout exceeded when trying to connect")
    );
    const response = await visit({ conversation_id: conversationId });
    expect(response.status).toBe(503);
    expect(response.text).toBe(JSON.stringify(errorBody("polis_err_get_participation_busy", 503)));
  });
});
