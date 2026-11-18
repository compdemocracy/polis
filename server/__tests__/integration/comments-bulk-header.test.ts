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
    ["headerless comments with trailing commas", "First seed,\r\nSecond seed,"],
    ["two trailing empty columns", "comment_text,,\nFirst seed,,"],
    ["leading empty column", ",comment_text\n,First seed"],
    [
      "a value under a trailing comma",
      "comment_text,\nFirst seed,\nSecond seed,example",
    ],
    [
      "a value under a trailing comma after IDs",
      `comment_text,original_id,\nFirst seed,${randomUUID()},example`,
    ],
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

  // A row the CSV parser cannot read is refused with 400 polis_err_csv_row and
  // a message naming the row (the header is row 1) and what is wrong, never
  // the row's text, before anything is stored: not the rows above it, and no
  // participant. These answered 500 polis_err_post_comments_bulk before.
  const commaRemedy =
    "This usually means a comment contains a comma: wrap that comment in double quotes.";
  test.each([
    [
      "eight lines, one header column, an unquoted comma in row 5",
      [
        "comment_text",
        "The library should open on Sundays",
        "More benches along the river path",
        "Bus shelters need better lighting",
        "Plant trees on the main street, near the school, and by the market",
        "Keep the pool open later in summer",
        "Add a crossing near the playground",
        "Weekly farmers market downtown",
      ].join("\n"),
      `Row 5 (the header is row 1) has 3 columns; the header has 1. ${commaRemedy}`,
    ],
    [
      "an unquoted comma in a row with an ID",
      `comment_text,original_id\r\nFirst seed,${randomUUID()}\r\nSecond, seed,${randomUUID()}\r\n`,
      `Row 3 (the header is row 1) has 3 columns; the header has 2. ${commaRemedy}`,
    ],
    [
      "a row missing its ID column",
      `comment_text,original_id\nFirst seed,${randomUUID()}\nSecond seed`,
      "Row 3 (the header is row 1) has 1 column; the header has 2. Every row needs a value for each column of the header; an empty value still needs its comma.",
    ],
    [
      "a row without the header's trailing comma",
      "comment_text,\nFirst seed,\nSecond seed",
      "Row 3 (the header is row 1) has 1 column; the header has 2, counting the empty column after its final comma. End every row with a comma as well, or remove the comma at the end of the header.",
    ],
    [
      "an unclosed double quote",
      'comment_text\nFirst seed\n"Second seed\nThird seed\n',
      "Row 3 (the header is row 1) opens a double quote that is never closed. A comment wrapped in double quotes must end with a double quote, and a double quote inside it must be written as two double quotes.",
    ],
    [
      "a double quote inside unquoted text",
      'comment_text\nFirst seed\nSecond "seed"',
      "Row 3 (the header is row 1) has a double quote inside a value that does not begin with one. Wrap that comment in double quotes and write each double quote inside it as two double quotes.",
    ],
    [
      "text after a closing double quote",
      'comment_text\nFirst seed\n"Second "seed" here"',
      "Row 3 (the header is row 1) has text right after a closing double quote. A double quote inside a quoted comment must be written as two double quotes.",
    ],
    [
      "a byte-order mark before a double quote",
      'comment_text\nFirst seed\n﻿"Second seed"',
      "Row 3 (the header is row 1) has a byte-order mark, an invisible character that belongs only at the start of a file, before a double quote. This usually means two files were joined: remove that character and upload again.",
    ],
    [
      "an unclosed double quote in the header",
      '"comment_text\nFirst seed',
      "The header (row 1) opens a double quote that is never closed. CSV header must be comment_text, optionally with original_id.",
    ],
  ])(
    "refuses %s with its row before storing anything",
    async (_label, csv, message) => {
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
        body: { error: "polis_err_csv_row", message, status: 400 },
        stored: before,
      });
    }
  );

  // A comma or a double quote inside a comment wrapped in double quotes is
  // well-formed: stored as written, as before.
  test.each([
    ["text only", ""],
    ["text then ID", ""],
    ["text only", "﻿"],
  ])("keeps a quoted comma unchanged: %s (BOM: %j)", async (format, bom) => {
    const { id, zid } = await conversation();
    const ids = [randomUUID(), randomUUID()];
    const texts = ["First seed, with a comma", 'Second "seed", quoted'];
    const quoted = ['"First seed, with a comma"', '"Second ""seed"", quoted"'];
    const csv =
      format === "text only"
        ? ["comment_text", ...quoted].join("\n")
        : [
            "comment_text,original_id",
            ...quoted.map((txt, i) => `${txt},${ids[i]}`),
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
  });

  // Excel and other spreadsheets often end every row with a comma, which
  // reads as one more column with no name. It is dropped, so the upload
  // stores what the same file without it stores.
  test.each(
    ["text only", "text then ID", "ID then text"].flatMap((format) => [
      [format, ""],
      [format, "\uFEFF"],
    ])
  )(
    "accepts a trailing comma on every row: %s (BOM: %j)",
    async (format, bom) => {
      const { id, zid } = await conversation();
      const ids = [randomUUID(), randomUUID()];
      const texts = ["First seed", "Second seed"];
      const lines =
        format === "text only"
          ? ["comment_text", ...texts]
          : format === "text then ID"
          ? [
              "comment_text,original_id",
              ...texts.map((txt, i) => `${txt},${ids[i]}`),
            ]
          : [
              "original_id,comment_text",
              ...texts.map((txt, i) => `${ids[i]},${txt}`),
            ];
      const response = await owner.post("/api/v3/comments-bulk").send({
        conversation_id: id,
        is_seed: true,
        csv: bom + lines.map((line) => `${line},\r\n`).join(""),
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
