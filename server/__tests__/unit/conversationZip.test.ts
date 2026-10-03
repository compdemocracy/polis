/**
 * The per-conversation export zip (src/export/zipStream.ts,
 * src/export/conversationZip.ts) and the GET /api/v3/dataExport branch that
 * streams it when no S3 bucket is configured or OFFLINE is set.
 *
 * Every CSV here is a generated fixture: deterministic rows built in this file,
 * fed through producers that write the way the report export functions do
 * (`send` once, or `write` many times across ticks and then `end`). The archive
 * is read back with an independent reader below, so the writer is not checked
 * against itself.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { PassThrough } from "stream";
import zlib from "zlib";

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP_readOnly: jest.fn(), queryP: jest.fn() },
}));
jest.mock("../../src/report", () => ({
  sendConversationSummary: jest.fn(),
  sendCommentSummary: jest.fn(),
  sendVotesSummary: jest.fn(),
  sendParticipantVotesSummary: jest.fn(),
}));
jest.mock("../../src/utils/common", () => ({
  isModerator: jest.fn(),
  doAddDataExportTask: jest.fn(),
}));
jest.mock("../../src/user", () => ({ getUserInfoForUid2: jest.fn() }));
jest.mock("../../src/utils/zinvite", () => ({ getZinvite: jest.fn() }));
jest.mock("../../src/utils/logger");

import Config from "../../src/config";
import pg from "../../src/db/pg-query";
import * as report from "../../src/report";
import { doAddDataExportTask, isModerator } from "../../src/utils/common";
import { getUserInfoForUid2 } from "../../src/user";
import { getZinvite } from "../../src/utils/zinvite";
import { exportFormatJson } from "../../src/votes/exportFormat";
import {
  CONVERSATION_ZIP_FILES,
  ConversationZipFile,
  ExportProducer,
  dataExportStreamsLocally,
  writeConversationZip,
} from "../../src/export/conversationZip";
import { ZipStreamWriter } from "../../src/export/zipStream";
import {
  handle_GET_dataExport,
  handle_GET_dataExport_results,
} from "../../src/routes/dataExport";

// ---------------------------------------------------------------- zip reader

interface ReadEntry {
  name: string;
  data: Buffer;
  flags: number;
  method: number;
}

/** Read a zip from its central directory, checking every size and CRC. */
function readZip(buf: Buffer): ReadEntry[] {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  expect(buf.readUInt16LE(eocd + 8)).toBe(count);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  expect(dirOffset + dirSize).toBe(eocd);

  const entries: ReadEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    expect(
      buf.toString("utf8", localOffset + 30, localOffset + 30 + localNameLen)
    ).toBe(name);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    expect(data.length).toBe(usize);
    expect(zlib.crc32(data) >>> 0).toBe(crc);
    // The data descriptor after the data repeats the CRC and sizes.
    const desc = dataStart + csize;
    expect(buf.readUInt32LE(desc)).toBe(0x08074b50);
    expect(buf.readUInt32LE(desc + 4)).toBe(crc);
    expect(buf.readUInt32LE(desc + 8)).toBe(csize);
    expect(buf.readUInt32LE(desc + 12)).toBe(usize);
    entries.push({ name, data, flags, method });
  }
  return entries;
}

function collect(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return new Promise((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------- generated fixtures

/** A small deterministic generator, so the fixtures are the same every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function generatedVotesCsv(rows: number, seed: number): string[] {
  const rand = lcg(seed);
  const lines = ["timestamp,datetime,comment-id,voter-id,vote\n"];
  for (let i = 0; i < rows; i++) {
    const t = 1700000000 + Math.floor(rand() * 1e6);
    const vote = [-1, 0, 1][Math.floor(rand() * 3)];
    lines.push(
      `${t},${new Date(t * 1000).toString()},${Math.floor(
        rand() * 50
      )},${i},${vote}\n`
    );
  }
  return lines;
}

/** Writes like sendVotesSummary: header, rows over several ticks, then end(). */
function streamingProducer(lines: string[]): ExportProducer {
  return (_zid, _siteUrl, res) => {
    res.setHeader("Content-Type", "text/csv");
    res.write(lines[0]);
    let i = 1;
    const tick = () => {
      const stop = Math.min(i + 97, lines.length);
      for (; i < stop; i++) res.write(lines[i]);
      if (i < lines.length) setImmediate(tick);
      else res.end();
    };
    setImmediate(tick);
  };
}

/** Writes like sendCommentSummary: one send() after an await. */
function sendingProducer(text: string): ExportProducer {
  return async (_zid, _siteUrl, res) => {
    await Promise.resolve();
    res.setHeader("content-type", "text/csv");
    res.send(text);
  };
}

function generatedFixtures(): {
  producers: Record<ConversationZipFile, ExportProducer>;
  expected: Record<ConversationZipFile, string>;
} {
  const votes = generatedVotesCsv(4000, 7);
  const matrix = [
    "participant,group-id,n-comments,n-votes,n-agree,n-disagree,1,2\n",
  ];
  for (let pid = 0; pid < 300; pid++) {
    matrix.push(`${pid},${pid % 3},0,2,1,1,1,-1\n`);
  }
  const summary =
    'topic,"Generated fixture: café ☕"\nurl,http://box/abc\nvoters,300\n' +
    "vote-convention,agree=+1;disagree=-1;pass=0;format=polis-export/1";
  const comments =
    "timestamp,datetime,comment-id,author-id,agrees,disagrees,moderated,comment-body\n" +
    '1700000000,x,1,0,3,1,0,"a body, with ""quotes"" and\nnewline"\n';
  return {
    producers: {
      "format.json": sendingProducer(exportFormatJson()),
      "summary.csv": sendingProducer(summary),
      "comments.csv": sendingProducer(comments),
      "votes.csv": streamingProducer(votes),
      "participant-votes.csv": streamingProducer(matrix),
    },
    expected: {
      "format.json": exportFormatJson(),
      "summary.csv": summary,
      "comments.csv": comments,
      "votes.csv": votes.join(""),
      "participant-votes.csv": matrix.join(""),
    },
  };
}

// ----------------------------------------------------------------- the writer

describe("ZipStreamWriter", () => {
  test("writes deflated entries with data descriptors that an independent reader accepts", async () => {
    const out = new PassThrough();
    const bytes = collect(out);
    const zip = new ZipStreamWriter(
      out,
      new Date(Date.UTC(2026, 9, 3, 12, 0, 0))
    );
    await zip.entry("a.txt", async (sink) => sink.write("hello\n"));
    await zip.entry("empty.txt", async () => undefined);
    await zip.entry("ünï.bin", async (sink) =>
      sink.write(Buffer.from([0, 1, 2, 255]))
    );
    await zip.finish();
    const entries = readZip(await bytes);
    expect(entries.map((e) => e.name)).toEqual([
      "a.txt",
      "empty.txt",
      "ünï.bin",
    ]);
    expect(entries[0].data.toString()).toBe("hello\n");
    expect(entries[1].data.length).toBe(0);
    expect([...entries[2].data]).toEqual([0, 1, 2, 255]);
    for (const e of entries) {
      expect(e.method).toBe(8);
      expect(e.flags & 0x0808).toBe(0x0808);
    }
  });

  test("streams a multi-megabyte entry without holding it: bytes leave before the entry ends", async () => {
    const out = new PassThrough();
    const bytes = collect(out);
    let emittedBeforeEnd = 0;
    out.on("data", (c: Buffer) => (emittedBeforeEnd += c.length));
    const zip = new ZipStreamWriter(out);
    const rand = lcg(11);
    const parts: string[] = [];
    let sawOutputMidEntry = false;
    await zip.entry("big.csv", async (sink) => {
      for (let i = 0; i < 8000; i++) {
        // incompressible enough that deflate has to emit as it goes
        const line =
          Array.from({ length: 40 }, () => Math.floor(rand() * 1e9)).join(",") +
          "\n";
        parts.push(line);
        sink.write(line);
        if (i % 200 === 0) await new Promise((r) => setImmediate(r));
        if (i > 4000 && emittedBeforeEnd > 100_000) sawOutputMidEntry = true;
      }
    });
    await zip.finish();
    const [entry] = readZip(await bytes);
    expect(entry.data.toString()).toBe(parts.join(""));
    expect(entry.data.length).toBeGreaterThan(3_000_000);
    expect(sawOutputMidEntry).toBe(true);
  });

  test("refuses entries out of sequence", async () => {
    const zip = new ZipStreamWriter(new PassThrough());
    let release: () => void = () => undefined;
    const first = zip.entry("a", () => new Promise<void>((r) => (release = r)));
    await expect(zip.entry("b", async () => undefined)).rejects.toThrow(
      "polis_err_zip_entry_sequence"
    );
    release();
    await first;
  });
});

// --------------------------------------------------------------- the assembly

describe("writeConversationZip", () => {
  test("the zip holds the five files, in order, each byte-identical to what its producer wrote", async () => {
    const { producers, expected } = generatedFixtures();
    const out = new PassThrough();
    const bytes = collect(out);
    await writeConversationZip(out, 42, "http://box", producers);
    const entries = readZip(await bytes);
    expect(entries.map((e) => e.name)).toEqual([...CONVERSATION_ZIP_FILES]);
    expect(CONVERSATION_ZIP_FILES).toEqual([
      "format.json",
      "summary.csv",
      "comments.csv",
      "votes.csv",
      "participant-votes.csv",
    ]);
    for (const e of entries) {
      expect(
        e.data.equals(
          Buffer.from(expected[e.name as ConversationZipFile], "utf8")
        )
      ).toBe(true);
    }
  });

  test("passes the conversation and site URL to every producer", async () => {
    const { producers } = generatedFixtures();
    const seen: [number, string][] = [];
    for (const name of CONVERSATION_ZIP_FILES) {
      const inner = producers[name];
      producers[name] = (zid, siteUrl, res) => {
        seen.push([zid, siteUrl]);
        return inner(zid, siteUrl, res);
      };
    }
    const out = new PassThrough();
    const bytes = collect(out);
    await writeConversationZip(out, 42, "https://box.local", producers);
    await bytes;
    expect(seen).toEqual(
      CONVERSATION_ZIP_FILES.map(() => [42, "https://box.local"])
    );
  });

  test("a producer that answers with an error status fails the export with its reason", async () => {
    const { producers } = generatedFixtures();
    producers["votes.csv"] = (_zid, _siteUrl, res) => {
      res.write("timestamp\n");
      res.status(500).json({ error: "polis_err_data_export" });
    };
    const out = new PassThrough();
    out.resume();
    await expect(
      writeConversationZip(out, 1, "http://box", producers)
    ).rejects.toThrow("polis_err_data_export (500)");
  });

  test("a producer that rejects fails the export", async () => {
    const { producers } = generatedFixtures();
    producers["participant-votes.csv"] = async () => {
      throw new Error("polis_err_generated_failure");
    };
    const out = new PassThrough();
    out.resume();
    await expect(
      writeConversationZip(out, 1, "http://box", producers)
    ).rejects.toThrow("polis_err_generated_failure");
  });
});

// ---------------------------------------------------------------- the route

type MockRes = PassThrough & {
  setHeader: jest.Mock;
  status: jest.Mock;
  json: jest.Mock;
  redirect: jest.Mock;
  headersSent: boolean;
  statusCode?: number;
  body?: any;
};

function mockRes(): MockRes {
  const res = new PassThrough() as MockRes;
  res.setHeader = jest.fn();
  res.json = jest.fn((body: any) => {
    res.body = body;
    res.end();
    return res;
  });
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.redirect = jest.fn();
  return res;
}

const saved = {
  bucket: Config.AWS_S3_BUCKET_NAME,
  offline: Config.offline,
  limit: Config.dataExportMaxCells,
};

function useGeneratedReport() {
  const { expected } = generatedFixtures();
  (report.sendConversationSummary as jest.Mock).mockImplementation(
    async (_zid: any, _siteUrl: any, res: any) =>
      res.send(expected["summary.csv"])
  );
  (report.sendCommentSummary as jest.Mock).mockImplementation(
    async (_zid: any, res: any) => res.send(expected["comments.csv"])
  );
  (report.sendVotesSummary as jest.Mock).mockImplementation(
    async (_zid: any, res: any) => {
      res.write(expected["votes.csv"]);
      res.end();
    }
  );
  (report.sendParticipantVotesSummary as jest.Mock).mockImplementation(
    async (_zid: any, res: any) => {
      res.write(expected["participant-votes.csv"]);
      res.end();
    }
  );
  return expected;
}

function counts(votes: number, voters: number, comments: number) {
  (pg.queryP_readOnly as jest.Mock).mockResolvedValue([
    {
      votes: String(votes),
      voters: String(voters),
      comments: String(comments),
    },
  ] as never);
}

describe("GET /api/v3/dataExport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Config.AWS_S3_BUCKET_NAME = saved.bucket;
    Config.offline = saved.offline;
    Config.dataExportMaxCells = saved.limit;
    (isModerator as jest.Mock).mockResolvedValue(true as never);
    (getZinvite as jest.Mock).mockResolvedValue("abc123" as never);
    (getUserInfoForUid2 as jest.Mock).mockResolvedValue({
      email: "owner@example.test",
    } as never);
    (doAddDataExportTask as jest.Mock).mockResolvedValue(undefined as never);
  });

  afterAll(() => {
    Config.AWS_S3_BUCKET_NAME = saved.bucket;
    Config.offline = saved.offline;
    Config.dataExportMaxCells = saved.limit;
  });

  const req = {
    p: { uid: 7, zid: 42, unixTimestamp: 1700000000, format: "csv" },
    headers: { host: "box.local", "x-forwarded-proto": "https" },
  };

  test("serves locally when the bucket is unset or OFFLINE is set, and only then", () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    Config.offline = false;
    expect(dataExportStreamsLocally()).toBe(true);
    Config.AWS_S3_BUCKET_NAME = "a-bucket";
    expect(dataExportStreamsLocally()).toBe(false);
    Config.offline = true;
    expect(dataExportStreamsLocally()).toBe(true);
  });

  test("with a bucket and OFFLINE unset, enqueues the worker task exactly as before", async () => {
    Config.AWS_S3_BUCKET_NAME = "a-bucket";
    Config.offline = false;
    const res = mockRes();
    await handle_GET_dataExport(req as any, res);
    expect(doAddDataExportTask).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({});
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(pg.queryP_readOnly).not.toHaveBeenCalled();
  });

  test.each([
    ["no bucket", undefined, false],
    ["OFFLINE with a bucket", "a-bucket", true],
  ])(
    "%s: streams the zip of the report export files",
    async (_label, bucket, offline) => {
      Config.AWS_S3_BUCKET_NAME = bucket as any;
      Config.offline = offline as boolean;
      counts(4000, 300, 2);
      const expected = useGeneratedReport();
      const res = mockRes();
      const bytes = collect(res);
      await handle_GET_dataExport(req as any, res);
      const entries = readZip(await bytes);

      expect(doAddDataExportTask).not.toHaveBeenCalled();
      expect(getUserInfoForUid2).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/zip"
      );
      const disposition = (res.setHeader as jest.Mock).mock.calls.find(
        ([k]) => k === "Content-Disposition"
      )?.[1] as string;
      expect(disposition).toMatch(
        /^attachment; filename="polis-export-abc123-\d+\.zip"$/
      );
      expect(entries.map((e) => e.name)).toEqual([...CONVERSATION_ZIP_FILES]);
      for (const e of entries) {
        expect(e.data.toString("utf8")).toBe(
          expected[e.name as ConversationZipFile]
        );
      }
      expect(report.sendConversationSummary).toHaveBeenCalledWith(
        42,
        "https://box.local",
        expect.anything()
      );
    }
  );

  test("over the size limit: 413 with the closed reason, before any byte of zip", async () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    Config.dataExportMaxCells = 1000;
    // 10 votes but 50 voters x 40 comments = 2000 matrix cells
    counts(10, 50, 40);
    const res = mockRes();
    await handle_GET_dataExport(req as any, res);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.body).toMatchObject({
      error: "polis_err_data_export_too_large",
      cells: 2000,
      limit: 1000,
    });
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(report.sendVotesSummary).not.toHaveBeenCalled();
  });

  test("at the size limit exactly: streams", async () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    Config.dataExportMaxCells = 2000;
    counts(2000, 10, 10);
    useGeneratedReport();
    const res = mockRes();
    const bytes = collect(res);
    await handle_GET_dataExport(req as any, res);
    expect(readZip(await bytes)).toHaveLength(5);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("the ownership gate is unchanged when streaming", async () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    (isModerator as jest.Mock).mockResolvedValue(false as never);
    const res = mockRes();
    await handle_GET_dataExport(req as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toBe("polis_err_data_export_auth");
    expect(pg.queryP_readOnly).not.toHaveBeenCalled();
  });

  test("a failure after the zip has started cuts the connection instead of finishing a short archive", async () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    counts(1, 1, 1);
    useGeneratedReport();
    (report.sendVotesSummary as jest.Mock).mockImplementation(
      async (_zid: any, res: any) => {
        res.write("timestamp\n");
        res.status(500).json({ error: "polis_err_data_export" });
      }
    );
    const res = mockRes();
    res.resume();
    let destroyed = false;
    res.on("close", () => (destroyed = true));
    // PassThrough reports headersSent only through this flag
    res.headersSent = true;
    await handle_GET_dataExport(req as any, res);
    expect(destroyed || res.destroyed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("GET /api/v3/dataExport/results", () => {
  const req = {
    p: {
      uid: 7,
      zid: 42,
      conversation_id: "abc123",
      filename: "polis-export-abc123-1758000000000.zip",
    },
  };

  test("when the export is streamed, there is no stored dump to sign: 404", async () => {
    Config.AWS_S3_BUCKET_NAME = undefined;
    (isModerator as jest.Mock).mockResolvedValue(true as never);
    const res = mockRes();
    await handle_GET_dataExport_results(req as any, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toBe("polis_err_data_export_results_not_stored");
    expect(res.redirect).not.toHaveBeenCalled();
    Config.AWS_S3_BUCKET_NAME = saved.bucket;
  });
});
