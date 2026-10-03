/**
 * pg-query's `stream_queryP_readOnly` under src/db/streamControl.ts: outside a
 * control context it behaves as before; inside one, an abort destroys the
 * running stream (closing its cursor and discarding the client) or fails a
 * stream that has not started, and the stream pauses while the output needs
 * draining. `pg` is replaced by a fake pool whose query stream is a plain
 * object-mode Readable of generated rows.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { PassThrough, Readable } from "stream";

const fake: { stream?: Readable; done?: jest.Mock; rows: number } = {
  rows: 0,
};

jest.mock("pg", () => {
  class Pool {
    on() {
      return this;
    }
    connect(cb: (err: unknown, client: unknown, done: unknown) => void) {
      fake.done = jest.fn();
      const client = {
        query: () => {
          let i = 0;
          fake.stream = new Readable({
            objectMode: true,
            highWaterMark: 4,
            read() {
              // One row per tick, like rows arriving off a socket.
              setImmediate(() => {
                if (i < fake.rows) this.push({ n: i++ });
                else this.push(null);
              });
            },
          });
          return fake.stream;
        },
      };
      setImmediate(() => cb(undefined, client, fake.done));
    }
  }
  return { __esModule: true, Pool, default: { Pool } };
});
jest.mock("pg-query-stream", () => ({
  __esModule: true,
  default: class {
    constructor() {
      return {};
    }
  },
}));
jest.mock("pg-connection-string", () => ({ parse: () => ({}) }));
jest.mock("../../src/utils/logger");

import pg from "../../src/db/pg-query";
import { QUERY_ABORTED, streamControl } from "../../src/db/streamControl";

function run(control?: { signal?: AbortSignal; output?: any }) {
  const rows: any[] = [];
  let resolveDone: (v: string) => void = () => undefined;
  const settled = new Promise<string>((r) => (resolveDone = r));
  const onRow = jest.fn((row: any) => rows.push(row));
  const start = () =>
    pg.stream_queryP_readOnly(
      "SELECT generated",
      [],
      onRow,
      () => resolveDone("end"),
      (err: Error) => resolveDone(`error:${err.message}`)
    );
  if (control) streamControl.run(control, start);
  else start();
  return { rows, settled, onRow };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("stream_queryP_readOnly with stream control", () => {
  beforeEach(() => {
    fake.stream = undefined;
    fake.rows = 0;
  });

  test("without a control context: every row, then end, client released cleanly", async () => {
    fake.rows = 50;
    const { rows, settled } = run();
    expect(await settled).toBe("end");
    expect(rows).toHaveLength(50);
    expect(fake.done).toHaveBeenCalledWith();
  });

  test("an abort mid-stream destroys the stream and discards the client", async () => {
    fake.rows = 100_000;
    const aborter = new AbortController();
    const { rows, settled } = run({ signal: aborter.signal });
    while (rows.length < 100) await tick();
    aborter.abort();
    expect(await settled).toBe(`error:${QUERY_ABORTED}`);
    expect(fake.stream!.destroyed).toBe(true);
    expect(rows.length).toBeLessThan(100_000);
    // done(error): the pool discards the client instead of reusing it.
    expect(fake.done).toHaveBeenCalledWith(expect.any(Error));
  });

  test("a signal aborted before the pool hands over a client: no query starts", async () => {
    fake.rows = 10;
    const aborter = new AbortController();
    aborter.abort();
    const { settled, onRow } = run({ signal: aborter.signal });
    expect(await settled).toBe(`error:${QUERY_ABORTED}`);
    expect(fake.stream).toBeUndefined();
    expect(onRow).not.toHaveBeenCalled();
    expect(fake.done).toHaveBeenCalledWith();
  });

  test("pauses while the output needs draining, resumes on drain", async () => {
    fake.rows = 1000;
    const output = new PassThrough({ highWaterMark: 16 });
    // Nobody reads `output`; fill it past its high-water mark.
    output.write(Buffer.alloc(64));
    expect(output.writableNeedDrain).toBe(true);
    const { rows, settled } = run({ output });
    while (rows.length < 1) await tick();
    for (let i = 0; i < 10; i++) await tick();
    // One row, then paused.
    expect(rows).toHaveLength(1);
    expect(fake.stream!.isPaused()).toBe(true);
    output.resume(); // drains -> "drain" -> stream resumes
    expect(await settled).toBe("end");
    expect(rows).toHaveLength(1000);
  });
});
