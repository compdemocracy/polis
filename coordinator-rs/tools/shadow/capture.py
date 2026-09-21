"""Private same-host HTTP capture; never boot the characterization application.

Only explicit GET requests from the frozen inventory reach a Unix socket. This
transport does not attest a Node process or manufacture a historical reader view;
the trusted local collector must separately supply those admission bindings.
Bodies live in memory only and never appear in exported receipts or errors.
"""
from __future__ import annotations

import hashlib
import http.client
from pathlib import Path
import socket
import stat
from urllib.parse import urlsplit

import daily

HEADERS = frozenset(("accept", "accept-encoding", "authorization", "cookie",
                     "if-none-match", "if-modified-since"))
OBSERVED = ("content-type", "etag", "cache-control", "vary", "content-encoding",
            "content-length", "transfer-encoding")


def request_digest(path, headers):
    return hashlib.sha256(daily.canonical({"method": "GET", "path": path,
                                          "headers": headers})).hexdigest()


def admit_request(route, inventory, headers):
    daily.admit_route(route, inventory)
    if type(headers) is not dict or any(
        name not in HEADERS or type(value) is not str or len(value) > 8192 or
        any(ord(c) < 32 or ord(c) == 127 for c in value)
        for name, value in headers.items()
    ):
        raise ValueError("SHADOW_REQUEST")
    path = route["path"]
    parsed = urlsplit(path)
    if (len(path) > 8192 or parsed.scheme or parsed.netloc or parsed.fragment or
            any(ord(c) < 32 or ord(c) == 127 for c in path) or
            request_digest(path, headers) != route["request_sha256"]):
        raise ValueError("SHADOW_REQUEST")
    # query_sha256 remains the collector's pinned SQL/query-contract identity.
    # HTTP path/query/auth bytes are already included in request_sha256.


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, uid, pid, timeout=10):
        super().__init__("localhost", timeout=timeout)
        self.path, self.uid, self.pid = path, uid, pid

    def connect(self):
        path = Path(self.path)
        if not path.is_absolute() or path.is_symlink():
            raise ValueError("SHADOW_SOCKET")
        info = path.stat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != self.uid or info.st_mode & 0o007:
            raise ValueError("SHADOW_SOCKET")
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        try:
            connection.connect(str(path))
            # Socket inode ownership is checked on every connection. Linux also
            # binds it to the actual peer credential, closing replacement races.
            if hasattr(socket, "SO_PEERCRED"):
                import struct
                pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != self.uid or pid != self.pid:
                    raise ValueError("SHADOW_SOCKET_PEER")
            else:
                raise ValueError("SHADOW_SOCKET_PEER_UNAVAILABLE")
        except BaseException:
            connection.close()
            raise
        self.sock = connection


def capture(endpoint, route, inventory, headers):
    """No redirects, ambient proxy, credential installation, or mutating method."""
    daily.closed(endpoint, ("socket", "uid", "pid"))
    if (type(endpoint["uid"]) is not int or endpoint["uid"] < 0
            or type(endpoint["pid"]) is not int or endpoint["pid"] <= 0):
        raise ValueError("SHADOW_SOCKET")
    admit_request(route, inventory, headers)
    connection = UnixConnection(endpoint["socket"], endpoint["uid"], endpoint["pid"])
    try:
        # HTTPConnection.request silently adds Accept-Encoding: identity. That
        # would change the exact request the Node admission gate hashes.
        connection.putrequest("GET", route["path"], skip_accept_encoding=True)
        for name, value in headers.items():
            connection.putheader(name, value)
        connection.endheaders()
        response = connection.getresponse()
        values = {}
        for name in OBSERVED:
            found = response.headers.get_all(name, [])
            if len(found) > 1:
                raise ValueError("SHADOW_RESPONSE_HEADERS")
            values[name] = found[0] if found else None
        if values["content-length"] is not None and values["transfer-encoding"] is not None:
            raise ValueError("SHADOW_RESPONSE_HEADERS")
        length = values["content-length"]
        if length is not None and (len(length) > 12 or not length.isascii() or not length.isdecimal() or int(length) > daily.MAX_BODY):
            raise ValueError("SHADOW_BODY")
        raw = response.read(daily.MAX_BODY + 1)
        if len(raw) > daily.MAX_BODY:
            raise ValueError("SHADOW_BODY")
        if response.status != 304 and length is not None and len(raw) != int(length):
            raise ValueError("SHADOW_RESPONSE_INCOMPLETE")
        return dict(status=response.status, complete=True,
                    content_type=values["content-type"], etag=values["etag"],
                    cache_control=values["cache-control"], vary=values["vary"],
                    encoding=values["content-encoding"] or "identity", body=raw,
                    full_body=None)
    except (OSError, http.client.HTTPException):
        raise ValueError("SHADOW_CAPTURE_FAILED") from None
    finally:
        connection.close()


def pair(endpoints, route, inventory, headers):
    daily.closed(endpoints, ("clojure", "python"))
    if endpoints["clojure"]["socket"] == endpoints["python"]["socket"]:
        raise ValueError("SHADOW_DISTINCT_READERS")
    return tuple(capture(endpoints[engine], route, inventory, headers)
                 for engine in ("clojure", "python"))
