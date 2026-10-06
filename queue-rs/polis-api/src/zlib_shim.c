/* One-shot deflate over caller-owned buffers, with Node's zlib defaults:
 * level Z_DEFAULT_COMPRESSION, memLevel 8, Z_DEFAULT_STRATEGY. window_bits is
 * 15 + 16 for gzip (zlib.gzip / zlib.createGzip) and 15 for the zlib wrapper
 * (zlib.createDeflate). No IO, no allocation outside zlib's own state. */
#include "zlib.h"
#include <string.h>

int polis_api_deflate(const unsigned char *input, unsigned int length,
                      unsigned char *output, unsigned int *capacity,
                      int window_bits) {
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    int result = deflateInit2(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED,
                              window_bits, 8, Z_DEFAULT_STRATEGY);
    if (result != Z_OK) return result;
    /* The gzip header's OS byte is zlib's compile-time OS_CODE: 3 (Unix) in
     * the Linux Node build, 19 when this file is compiled on macOS. Pin the
     * Linux value so every build writes Node-on-Linux bytes. */
    gz_header header;
    memset(&header, 0, sizeof(header));
    header.os = 3;
    if (window_bits > 15) {
        result = deflateSetHeader(&stream, &header);
        if (result != Z_OK) { deflateEnd(&stream); return result; }
    }
    stream.next_in = (unsigned char *)input;
    stream.avail_in = length;
    stream.next_out = output;
    stream.avail_out = *capacity;
    result = deflate(&stream, Z_FINISH);
    *capacity = (unsigned int)stream.total_out;
    deflateEnd(&stream);
    return result == Z_STREAM_END ? Z_OK : (result == Z_OK ? Z_BUF_ERROR : result);
}

/* What a Node zlib stream (zlib.createGzip / createDeflate, chunkSize 16 KiB)
 * emits when the compression middleware calls stream.end(body): body is
 * written with Z_NO_FLUSH (usually only the wrapper header comes out), then
 * the stream is finished with Z_FINISH. Node copies output into a 16 KiB
 * buffer at a running offset and emits one 'data' event per deflate call that
 * produced bytes, starting a fresh buffer when the current one is full. Each
 * event becomes one HTTP chunk, so the piece sizes are part of the wire.
 * An empty body is `stream.end()` with no chunk: there is no write, only
 * the finish. sizes[] receives the size of each piece, in order. */
int polis_api_deflate_stream(const unsigned char *input, unsigned int length,
                             unsigned char *output, unsigned int *capacity,
                             int window_bits, unsigned int *sizes,
                             unsigned int *pieces) {
    const unsigned int chunk_size = 16 * 1024;
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    int result = deflateInit2(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED,
                              window_bits, 8, Z_DEFAULT_STRATEGY);
    if (result != Z_OK) return result;
    gz_header header;
    memset(&header, 0, sizeof(header));
    header.os = 3;
    if (window_bits > 15) {
        result = deflateSetHeader(&stream, &header);
        if (result != Z_OK) { deflateEnd(&stream); return result; }
    }
    unsigned int written = 0, count = 0, offset = 0, max_pieces = *pieces;
    stream.next_in = (unsigned char *)input;
    stream.avail_in = length;
    for (int phase = length == 0 ? 1 : 0; phase < 2; phase++) {
        int flush = phase == 0 ? Z_NO_FLUSH : Z_FINISH;
        for (;;) {
            unsigned int before = chunk_size - offset;
            if (written + before > *capacity || count >= max_pieces) {
                deflateEnd(&stream);
                return Z_BUF_ERROR;
            }
            stream.next_out = output + written;
            stream.avail_out = before;
            result = deflate(&stream, flush);
            if (result != Z_OK && result != Z_STREAM_END && result != Z_BUF_ERROR) {
                deflateEnd(&stream);
                return result;
            }
            unsigned int have = before - stream.avail_out;
            if (have > 0) {
                sizes[count++] = have;
                written += have;
                offset += have;
            }
            if (stream.avail_out == 0 || offset >= chunk_size) offset = 0;
            if (stream.avail_out != 0) break;
        }
    }
    *capacity = written;
    *pieces = count;
    deflateEnd(&stream);
    return result == Z_STREAM_END ? Z_OK : Z_BUF_ERROR;
}
