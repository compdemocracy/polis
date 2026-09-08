/* Small safe-buffer adapter around the pinned Node compressor. No IO. */
#include "zlib.h"
#include <string.h>
int p032_gzip(const unsigned char *input, unsigned int length,
              unsigned char *output, unsigned int *capacity) {
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    int result = deflateInit2(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED,
                              15 + 16, 8, Z_DEFAULT_STRATEGY);
    if (result != Z_OK) return result;
    gz_header header;
    memset(&header, 0, sizeof(header));
    header.os = 3;
    result = deflateSetHeader(&stream, &header);
    if (result != Z_OK) { deflateEnd(&stream); return result; }
    stream.next_in = (unsigned char *)input;
    stream.avail_in = length;
    stream.next_out = output;
    stream.avail_out = *capacity;
    result = deflate(&stream, Z_FINISH);
    *capacity = stream.total_out;
    deflateEnd(&stream);
    return result == Z_STREAM_END ? Z_OK : result;
}
