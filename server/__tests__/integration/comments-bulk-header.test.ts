import { randomUUID } from "crypto";
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { pool } from "../setup/db-test-helpers";

describe("bulk seed CSV header", () => {
  let owner: Agent;

  beforeAll(async () => {
    const user = getPooledTestUser(1);
    ({ agent: owner } = await getJwtAuthenticatedAgent({
      email: user.email,
      hname: user.name,
      password: user.password,
    }));
  });

  async function conversation() {
    const id = await createConversation(owner, {
      topic: `CSV header ${randomUUID()}`,
    });
    const { rows } = await pool.query(
      "select zid from zinvites where zinvite = $1",
      [id]
    );
    return { id, zid: rows[0].zid as number };
  }

  async function stored(zid: number) {
    const tables = [
      "conversations",
      "participants",
      "comments",
      "votes",
      "votes_latest_unique",
    ];
    return Promise.all(
      tables.map(async (table) => {
        const { rows } = await pool.query(
          `select * from ${table} where zid = $1`,
          [zid]
        );
        return { table, rows };
      })
    );
  }

  test.each([
    ["one headerless comment", "First seed"],
    ["multiple headerless comments", "First seed\nSecond seed"],
    [
      "headerless comments with IDs",
      `First seed,${randomUUID()}\nSecond seed,${randomUUID()}`,
    ],
    ["wrong name", "text\nFirst seed\nSecond seed"],
    ["wrong case", "Comment_text\nFirst seed"],
    ["header whitespace", " comment_text\nFirst seed"],
    ["ID without text", `original_id\n${randomUUID()}`],
    ["unknown column", "comment_text,source\nFirst seed,example"],
    ["duplicate column", "comment_text,comment_text\nFirst seed,Second seed"],
    ["wrong header with no data", "text"],
    ["no nonempty row", "\n\n"],
  ])("refuses %s before storing anything", async (_label, csv) => {
    const { id, zid } = await conversation();
    const before = await stored(zid);
    const response = await owner.post("/api/v3/comments-bulk").send({
      conversation_id: id,
      is_seed: true,
      csv,
    });

    expect({
      status: response.status,
      body: response.body,
      stored: await stored(zid),
    }).toEqual({
      status: 400,
      body: {
        error: "polis_err_csv_header",
        message:
          "CSV header must be comment_text, optionally with original_id.",
        status: 400,
      },
      stored: before,
    });
  });

  test.each(
    ["text only", "text then ID", "ID then text", "quoted header"].flatMap(
      (format) => [
        [format, ""],
        [format, "\uFEFF"],
      ]
    )
  )(
    "keeps a well-formed upload unchanged: %s (BOM: %j)",
    async (format, bom) => {
      const { id, zid } = await conversation();
      const ids = [randomUUID(), randomUUID()];
      const texts = ["First seed", "Second seed"];
      const csv =
        format === "text only"
          ? ["comment_text", ...texts].join("\n")
          : format === "ID then text"
          ? [
              "original_id,comment_text",
              ...texts.map((txt, i) => `${ids[i]},${txt}`),
            ].join("\n")
          : [
              format === "quoted header"
                ? '"comment_text","original_id"'
                : "comment_text,original_id",
              ...texts.map((txt, i) => `${txt},${ids[i]}`),
            ].join("\r\n");
      const response = await owner.post("/api/v3/comments-bulk").send({
        conversation_id: id,
        is_seed: true,
        csv: bom + csv,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        currentPid: 0,
        results: texts.map((txt, i) => ({
          txt,
          tid: i,
          status: "success",
          ...(format === "text only" ? {} : { original_id: ids[i] }),
        })),
      });
      const { rows } = await pool.query(
        "select txt, original_id, is_seed, mod, active from comments where zid = $1 order by tid",
        [zid]
      );
      expect(rows).toEqual(
        texts.map((txt, i) => ({
          txt,
          original_id: format === "text only" ? null : ids[i],
          is_seed: true,
          mod: 1,
          active: true,
        }))
      );
    }
  );
});
