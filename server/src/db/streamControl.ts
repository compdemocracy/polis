/**
 * Optional control over the Postgres row streams (pg-query.ts
 * `stream_queryP_readOnly`) started inside `streamControl.run(...)`.
 *
 * The report export functions start their streams themselves and do not
 * return them, so a caller that needs to stop or slow those streams (the
 * streamed conversation zip, src/export/conversationZip.ts) sets this context
 * around them instead:
 *
 * - `signal`: when it aborts, a running stream is destroyed (its cursor closed
 *   and its pool client discarded) and a stream not yet started fails at once,
 *   both with QUERY_ABORTED through the caller's onError.
 * - `output`: after each row, while `output.writableNeedDrain`, the stream is
 *   paused until `output` emits "drain".
 *
 * Outside such a context nothing changes.
 */
import { AsyncLocalStorage } from "async_hooks";
import type { Writable } from "stream";

export interface StreamControl {
  signal?: AbortSignal;
  output?: Writable;
}

export const QUERY_ABORTED = "polis_err_query_aborted";

export const streamControl = new AsyncLocalStorage<StreamControl>();
