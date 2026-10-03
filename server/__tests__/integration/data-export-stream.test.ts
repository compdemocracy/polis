/**
 * GET /api/v3/dataExport, served by this server (no S3 bucket configured, or
 * OFFLINE set): the zip it streams holds the report export's files, and each
 * one is byte-identical to what /api/v3/reportExport/<report_id>/<file> serves
 * for the same conversation.
 *
 * Needs only Postgres. The conversation is a generated fixture written straight
 * into the database (owner, participants, comments with commas, quotes,
 * newlines and non-ASCII text, a vote history including changed and NULL
 * votes). Both handlers are mounted on a bare Express app so the comparison is
 * of the bytes each one puts on the wire; the routing and auth middleware in
 * app.ts are covered by data-export-authz.test.ts and the unit tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import zlib from "zlib";
import Config from "../../src/config";
import { handle_GET_dataExport } from "../../src/routes/dataExport";
import { handle_GET_reportExport } from "../../src/routes/export";
import { CONVERSATION_ZIP_FILES } from "../../src/export/conversationZip";
import { pool } from "../setup/db-test-helpers";

/** Entries of a zip, read from its central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + csize));
    expect(zlib.crc32(data) >>> 0).toBe(crc);
    out.set(name, data);
    p += 46 + skip;
  }
  return out;
}

function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

describe("dataExport streamed from the server", () => {
  const tag = `p053x${Date.now().toString(36)}`;
  const saved = {
    bucket: Config.AWS_S3_BUCKET_NAME,
    offline: Config.offline,
    limit: Config.dataExportMaxCells,
  };
  let ownerUid: number;
  let zid: number;
  let rid: number;
  let voteRows = 0;
  let app: any;

  beforeAll(async () => {
    const owner = await pool.query(
      "INSERT INTO users (hname, email, is_owner) VALUES ($1, $2, true) RETURNING uid",
      ["Generated fixture owner", `${tag}@example.test`]
    );
    ownerUid = owner.rows[0].uid;
    const convo = await pool.query(
      "INSERT INTO conversations (topic, description, owner) VALUES ($1, $2, $3) RETURNING zid",
      [`Generated fixture, "quoted", café`, "line one\nline two", ownerUid]
    );
    zid = convo.rows[0].zid;
    await pool.query("INSERT INTO zinvites (zid, zinvite) VALUES ($1, $2)", [
      zid,
      tag,
    ]);
    const report = await pool.query(
      "INSERT INTO reports (report_id, zid) VALUES ($1, $2) RETURNING rid",
      [`r${tag}`, zid]
    );
    rid = report.rows[0].rid;

    const pids: number[] = [];
    const uids: number[] = [ownerUid];
    for (let i = 0; i < 9; i++) {
      const u = await pool.query(
        "INSERT INTO users (hname) VALUES ($1) RETURNING uid",
        [`Generated fixture participant ${i}`]
      );
      uids.push(u.rows[0].uid);
    }
    for (const uid of uids) {
      const p = await pool.query(
        "INSERT INTO participants (pid, zid, uid) VALUES (NULL, $1, $2) RETURNING pid",
        [zid, uid]
      );
      pids.push(p.rows[0].pid);
    }

    const bodies = [
      "plain statement",
      'has a comma, and "quotes"',
      "has a\nnewline",
      "non-ASCII: naïve façade ☕ 日本語",
      "",
      "trailing space ",
    ];
    const tids: number[] = [];
    for (let i = 0; i < bodies.length; i++) {
      const author = i % 3;
      const c = await pool.query(
        "INSERT INTO comments (tid, zid, pid, uid, txt, created, velocity, mod) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7) RETURNING tid",
        [
          zid,
          pids[author],
          uids[author],
          bodies[i] || "(empty)",
          1700000000000 + i * 1000,
          1 - i / 10,
          [0, 1, -1][i % 3],
        ]
      );
      tids.push(c.rows[0].tid);
    }

    // A deterministic vote history: most participants vote on most comments,
    // a few change their vote later, one vote is stored NULL.
    let t = 1700000100000;
    for (let pi = 0; pi < pids.length; pi++) {
      for (let ci = 0; ci < tids.length; ci++) {
        if ((pi * 7 + ci * 3) % 5 === 0) continue;
        const stored = [-1, 1, 0][(pi + ci) % 3];
        await pool.query(
          "INSERT INTO votes (zid, pid, tid, vote, created, high_priority) VALUES ($1, $2, $3, $4, $5, $6)",
          [zid, pids[pi], tids[ci], stored, (t += 1000), (pi + ci) % 4 === 0]
        );
        voteRows++;
        if ((pi + ci) % 6 === 0) {
          await pool.query(
            "INSERT INTO votes (zid, pid, tid, vote, created) VALUES ($1, $2, $3, $4, $5)",
            [zid, pids[pi], tids[ci], -stored || 1, (t += 1000)]
          );
          voteRows++;
        }
      }
    }
    await pool.query(
      "INSERT INTO votes (zid, pid, tid, vote, created) VALUES ($1, $2, $3, NULL, $4)",
      [zid, pids[1], tids[0], (t += 1000)]
    );
    voteRows++;

    app = express();
    app.get("/report/:file", (req: any, res: any) => {
      req.p = { rid, report_id: `r${tag}`, report_type: req.params.file };
      handle_GET_reportExport(req, res);
    });
    app.get("/dataExport", (req: any, res: any) => {
      req.p = {
        uid: Number(req.query.uid),
        zid,
        unixTimestamp: 1,
        format: "csv",
      };
      handle_GET_dataExport(req, res);
    });
  });

  afterAll(async () => {
    Config.AWS_S3_BUCKET_NAME = saved.bucket;
    Config.offline = saved.offline;
    Config.dataExportMaxCells = saved.limit;
  });

  const headers = { host: "box.local", "x-forwarded-proto": "http" };

  async function streamedZip(): Promise<{
    status: number;
    body: Buffer;
    type: string;
  }> {
    const res = await request(app)
      .get(`/dataExport?uid=${ownerUid}`)
      .set(headers)
      .buffer(true)
      .parse(binary);
    return {
      status: res.status,
      body: res.body as Buffer,
      type: res.headers["content-type"],
    };
  }

  test("with no bucket configured, every file in the zip is byte-identical to the report export's", async () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    Config.offline = false;
    Config.dataExportMaxCells = saved.limit;

    const zip = await streamedZip();
    expect(zip.status).toBe(200);
    expect(zip.type).toContain("application/zip");
    const entries = unzip(zip.body);
    expect([...entries.keys()]).toEqual([...CONVERSATION_ZIP_FILES]);

    for (const file of CONVERSATION_ZIP_FILES) {
      const res = await request(app)
        .get(`/report/${file}`)
        .set(headers)
        .buffer(true)
        .parse(binary);
      expect(res.status).toBe(200);
      const served = res.body as Buffer;
      expect(served.length).toBeGreaterThan(0);
      expect(entries.get(file)!.equals(served)).toBe(true);
    }

    // The fixture reached the files: every vote row, and the awkward bodies.
    const votesCsv = entries.get("votes.csv")!.toString("utf8");
    expect(votesCsv.trimEnd().split("\n").length - 1).toBe(voteRows);
    expect(entries.get("comments.csv")!.toString("utf8")).toContain("日本語");
  });

  test("with OFFLINE set and a bucket configured, it streams the same zip", async () => {
    Config.AWS_S3_BUCKET_NAME = "a-bucket";
    Config.offline = true;
    const zip = await streamedZip();
    expect(zip.status).toBe(200);
    expect([...unzip(zip.body).keys()]).toEqual([...CONVERSATION_ZIP_FILES]);
  });

  test("over the size limit it refuses with 413 and the closed reason", async () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    Config.offline = false;
    Config.dataExportMaxCells = voteRows - 1;
    const res = await request(app)
      .get(`/dataExport?uid=${ownerUid}`)
      .set(headers);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("polis_err_data_export_too_large");
    expect(res.body.limit).toBe(voteRows - 1);
    expect(res.body.cells).toBeGreaterThanOrEqual(voteRows);
    expect(res.headers["content-type"]).not.toContain("application/zip");
    Config.dataExportMaxCells = saved.limit;
  });

  test("a caller who does not own the conversation is refused, as before", async () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    const stranger = await pool.query(
      "INSERT INTO users (hname) VALUES ('Generated fixture stranger') RETURNING uid"
    );
    const res = await request(app)
      .get(`/dataExport?uid=${stranger.rows[0].uid}`)
      .set(headers);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("polis_err_data_export_auth");
  });
});
