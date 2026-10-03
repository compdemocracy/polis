/**
 * A minimal streaming zip writer (PKWARE APPNOTE 6.3, no zip64).
 *
 * Entries are written one after another straight to `out`: a local header,
 * the deflated bytes as they are produced, then a data descriptor carrying the
 * CRC-32 and sizes (general purpose flag bit 3), so nothing about an entry has
 * to be known before its first byte goes out. Input is compressed
 * synchronously in runs of BLOCK_BYTES, each ending in a sync flush, so the
 * writer holds at most one run of input; the central directory (about 60 bytes
 * per entry) is kept until `finish()`. Like the report export's CSV routes, it
 * does not wait for `out` to drain.
 *
 * Without zip64 an archive, and every entry in it, must stay under 4 GiB; the
 * writer fails rather than emit a corrupt archive past that. Callers bound the
 * input first (see conversationZip.ts).
 */
import zlib from "zlib";
import type { Writable } from "stream";

const ZIP32_MAX = 0xffffffff;
// bit 3: sizes and CRC follow the data; bit 11: the name is UTF-8.
const FLAGS = 0x0808;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;
// Made by: Unix (3), spec 2.0, so the external attributes carry a file mode.
const VERSION_MADE_BY = (3 << 8) | 20;
const FILE_MODE = 0o100644;
// Input is compressed in runs of about this many bytes; at most one run is held.
const BLOCK_BYTES = 256 * 1024;
const SYNC_FLUSH = zlib.constants.Z_SYNC_FLUSH;
// A final, empty fixed-Huffman block: ends the deflate stream.
const FINAL_BLOCK = zlib.deflateRawSync(Buffer.alloc(0));

export const ZIP_TOO_LARGE = "polis_err_zip_too_large";

/** Where an entry's producer writes its uncompressed bytes. */
export interface ZipEntrySink {
  write(data: string | Buffer): void;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getUTCFullYear(), 1980);
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCSeconds() >> 1),
    date:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

export class ZipStreamWriter {
  private offset = 0;
  private readonly central: Buffer[] = [];
  private busy = false;
  private finished = false;
  private readonly stamp: { time: number; date: number };

  constructor(private readonly out: Writable, modified: Date = new Date()) {
    this.stamp = dosDateTime(modified);
  }

  private emit(buf: Buffer) {
    if (this.offset + buf.length > ZIP32_MAX) {
      throw new Error(ZIP_TOO_LARGE);
    }
    this.offset += buf.length;
    this.out.write(buf);
  }

  /**
   * Add one entry. `produce` writes the entry's bytes to the sink and resolves
   * when it has written them all; entries are written strictly in sequence.
   */
  async entry(
    name: string,
    produce: (sink: ZipEntrySink) => Promise<void>
  ): Promise<void> {
    if (this.busy || this.finished) {
      throw new Error("polis_err_zip_entry_sequence");
    }
    if (this.central.length >= 0xffff) {
      throw new Error(ZIP_TOO_LARGE);
    }
    this.busy = true;
    const nameBuf = Buffer.from(name, "utf8");
    const headerOffset = this.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(this.stamp.time, 10);
    local.writeUInt16LE(this.stamp.date, 12);
    // CRC-32 and both sizes stay zero here; the data descriptor carries them.
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    this.emit(local);
    this.emit(nameBuf);

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const out = (buf: Buffer) => {
      compressedSize += buf.length;
      this.emit(buf);
    };
    // Compress what is pending as one deflate block run ending in a sync flush
    // (never a final block), synchronously, and send it on. Concatenated, these
    // runs plus one final empty block are a single valid deflate stream.
    const flush = () => {
      if (pendingBytes === 0) return;
      const block = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      out(zlib.deflateRawSync(block, { finishFlush: SYNC_FLUSH }));
    };

    const sink: ZipEntrySink = {
      write: (data) => {
        const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
        if (buf.length === 0) return;
        if (size + buf.length > ZIP32_MAX) {
          throw new Error(ZIP_TOO_LARGE);
        }
        crc = zlib.crc32(buf, crc);
        size += buf.length;
        pending.push(buf);
        pendingBytes += buf.length;
        if (pendingBytes >= BLOCK_BYTES) flush();
      },
    };

    await produce(sink);
    flush();
    out(FINAL_BLOCK);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    this.emit(descriptor);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(VERSION_MADE_BY, 4);
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(FLAGS, 8);
    record.writeUInt16LE(METHOD_DEFLATE, 10);
    record.writeUInt16LE(this.stamp.time, 12);
    record.writeUInt16LE(this.stamp.date, 14);
    record.writeUInt32LE(crc >>> 0, 16);
    record.writeUInt32LE(compressedSize, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    // extra length, comment length, disk number, internal attributes: zero
    record.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    record.writeUInt32LE(headerOffset, 42);
    this.central.push(Buffer.concat([record, nameBuf]));
    this.busy = false;
  }

  /** Write the central directory and end-of-central-directory record, then end `out`. */
  async finish(): Promise<void> {
    if (this.busy || this.finished) {
      throw new Error("polis_err_zip_entry_sequence");
    }
    this.finished = true;
    const directoryOffset = this.offset;
    for (const record of this.central) {
      this.emit(record);
    }
    const directorySize = this.offset - directoryOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryOffset, 16);
    this.emit(end);
    await new Promise<void>((resolve) => this.out.end(resolve));
  }
}
