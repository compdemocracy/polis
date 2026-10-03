/**
 * The per-conversation export zip that GET /api/v3/dataExport streams when the
 * server serves the export itself.
 *
 * The route's original producer was the Clojure math worker, which read the
 * `generate_export_data` task the route enqueues in `worker_tasks`, wrote a zip
 * to the `polis-datadump` S3 bucket and mailed a link. Production stopped
 * consuming those tasks in 2022, and the worker is retired. On a box with no S3
 * bucket (or with OFFLINE set) there is nowhere for a dump to go either, so the
 * route builds the zip on request from the same functions that serve the report
 * export (/api/v3/reportExport/<report_id>/<file>): each file in the zip is the
 * byte sequence that route serves for the same conversation.
 *
 * The zip is written entry by entry to the response as the rows stream out of
 * Postgres; the writer holds at most one 256 KiB run of input. The Postgres
 * streams are paused while the response needs draining, so a slow client
 * slows the reads rather than growing Node's socket buffer, and when the
 * response closes early (the client went away) the current stream is
 * destroyed, its cursor closed, and the export rejects (src/db/streamControl.ts).
 * comments.csv and summary.csv are still built as one string each, exactly as
 * the report export builds them. A conversation over
 * `Config.dataExportMaxCells` is refused before the first byte (413).
 */
import type { Writable } from "stream";
import Config from "../config";
import pg from "../db/pg-query";
import { streamControl } from "../db/streamControl";
import {
  sendCommentSummary,
  sendConversationSummary,
  sendParticipantVotesSummary,
  sendVotesSummary,
} from "../report";
import { exportFormatJson } from "../votes/exportFormat";
import { ZIP_OUTPUT_CLOSED, ZipEntrySink, ZipStreamWriter } from "./zipStream";

/** The files in the zip, in order (docs/export-format.md). */
export const CONVERSATION_ZIP_FILES = [
  "format.json",
  "summary.csv",
  "comments.csv",
  "votes.csv",
  "participant-votes.csv",
] as const;

export type ConversationZipFile = (typeof CONVERSATION_ZIP_FILES)[number];

export const DATA_EXPORT_TOO_LARGE = "polis_err_data_export_too_large";

/**
 * The response surface the report export functions write to (report.ts):
 * `send` writes everything at once, `write`/`end` stream, and an error goes
 * out through failJson as `status(code).json(body)`.
 */
export interface ExportResponse {
  setHeader: (key: string, value: string) => void;
  send: (data: string) => void;
  write: (data: string) => void;
  end: () => void;
  status: (code: number) => { json: (body: unknown) => void };
}

export type ExportProducer = (
  zid: number,
  siteUrl: string,
  res: ExportResponse
) => unknown;

/** The report export's producer for each file, as handle_GET_reportExport calls it. */
export const REPORT_EXPORT_PRODUCERS: Record<
  ConversationZipFile,
  ExportProducer
> = {
  "format.json": (_zid, _siteUrl, res) => {
    res.setHeader("content-type", "application/json");
    res.send(exportFormatJson());
  },
  "summary.csv": (zid, siteUrl, res) =>
    sendConversationSummary(zid, siteUrl, res),
  "comments.csv": (zid, _siteUrl, res) => sendCommentSummary(zid, res),
  "votes.csv": (zid, _siteUrl, res) => sendVotesSummary(zid, res),
  "participant-votes.csv": (zid, _siteUrl, res) =>
    sendParticipantVotesSummary(zid, res),
};

/**
 * True when the route serves the export itself: no S3 bucket is configured,
 * or OFFLINE is set. Read at request time.
 */
export function dataExportStreamsLocally(): boolean {
  return Boolean(Config.offline) || !Config.AWS_S3_BUCKET_NAME;
}

/**
 * Run one report export producer into a zip entry. Resolves when the producer
 * ends its response; rejects if it answers with an error status or throws.
 */
export function runProducerIntoEntry(
  produce: ExportProducer,
  zid: number,
  siteUrl: string,
  sink: ZipEntrySink,
  control: { signal?: AbortSignal; output?: Writable } = {}
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => settle(new Error(ZIP_OUTPUT_CLOSED));
    const settle = (err?: unknown) => {
      if (settled) return;
      settled = true;
      control.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    if (control.signal?.aborted) return onAbort();
    control.signal?.addEventListener("abort", onAbort, { once: true });
    const write = (data: string) => {
      if (settled) return;
      try {
        sink.write(data);
      } catch (err) {
        // The producers write from inside Postgres stream callbacks, where a
        // throw would escape; fail the entry instead.
        settle(err);
      }
    };
    const res: ExportResponse = {
      setHeader: () => undefined,
      write,
      send: (data) => {
        write(data);
        settle();
      },
      end: () => settle(),
      status: (code) => ({
        json: (body) => {
          const reason =
            (body as { error?: string } | undefined)?.error ||
            "polis_err_data_export";
          settle(new Error(`${reason} (${code})`));
        },
      }),
    };
    // The producer's Postgres streams see the signal and the output through
    // this context: they stop on abort and pause while the output drains.
    streamControl.run(control, () => {
      Promise.resolve()
        .then(() => produce(zid, siteUrl, res))
        .catch((err) => settle(err));
    });
  });
}

/** Write every file of the conversation's export into `out` as a zip. */
export async function writeConversationZip(
  out: Writable,
  zid: number,
  siteUrl: string,
  producers: Record<
    ConversationZipFile,
    ExportProducer
  > = REPORT_EXPORT_PRODUCERS,
  modified: Date = new Date()
): Promise<void> {
  const zip = new ZipStreamWriter(out, modified);
  // A response that closes before the zip is complete (the client went away)
  // stops the current producer and its query; see streamControl.ts.
  const aborter = new AbortController();
  const onClose = () => aborter.abort();
  out.once("close", onClose);
  if (out.destroyed) aborter.abort();
  const control = { signal: aborter.signal, output: out };
  try {
    for (const name of CONVERSATION_ZIP_FILES) {
      await zip.entry(name, (sink) =>
        runProducerIntoEntry(producers[name], zid, siteUrl, sink, control)
      );
    }
    await zip.finish();
  } finally {
    out.off("close", onClose);
  }
}

export interface ConversationExportSize {
  votes: number;
  voters: number;
  comments: number;
  /** max(votes, voters x comments): the vote rows or matrix cells to write. */
  cells: number;
}

/** Count what the export would write, before writing any of it. */
export async function conversationExportSize(
  zid: number
): Promise<ConversationExportSize> {
  const rows = (await pg.queryP_readOnly(
    `SELECT v.votes, v.voters,
            (SELECT COUNT(*) FROM comments WHERE zid = $1) AS comments
       FROM (SELECT COUNT(*) AS votes, COUNT(DISTINCT pid) AS voters
               FROM votes WHERE zid = $1) v`,
    [zid]
  )) as { votes: string; voters: string; comments: string }[];
  const votes = Number(rows[0]?.votes || 0);
  const voters = Number(rows[0]?.voters || 0);
  const comments = Number(rows[0]?.comments || 0);
  return { votes, voters, comments, cells: Math.max(votes, voters * comments) };
}
