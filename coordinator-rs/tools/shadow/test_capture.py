import gzip
import hashlib
from http.server import BaseHTTPRequestHandler
import os
from pathlib import Path
import socketserver
import tempfile
import threading
import unittest

import capture
import daily


class Server(socketserver.UnixStreamServer):
    allow_reuse_address = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append((self.command, self.path, dict(self.headers)))
        self.send_response(self.server.status)
        for name, value in self.server.headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(self.server.body)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "reader.sock")
        self.server = Server(self.path, Handler)
        os.chmod(self.path, 0o600)
        self.server.requests = []
        self.server.status = 200
        self.server.body = b'[{"id":0,"value":1}]'
        self.server.headers = [("Content-Type", "application/json"), ("ETag", "public-validator")]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.headers = {"accept": "application/json", "authorization": "Bearer public-fixture"}
        path = "/api/v3/comments?conversation_id=7Public"
        self.route = dict(method="GET", path=path, **{"class": "COMMENT_MATH"}, unordered=True,
                          request_sha256=capture.request_digest(path, self.headers),
                          query_sha256=hashlib.sha256(b"public-comments-query-contract").hexdigest())
        self.endpoint = dict(socket=self.path, uid=os.getuid(), pid=os.getpid())

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def test_transport_does_not_add_unbound_accept_encoding(self):
        self.read()
        received = {name.lower(): value for name, value in self.server.requests[0][2].items()}
        self.assertNotIn("accept-encoding", received)
        self.assertEqual(received["authorization"], self.headers["authorization"])

    def read(self):
        return capture.capture(self.endpoint, self.route, [self.route], self.headers)

    def test_actual_unix_http_reads_exact_bytes_and_headers(self):
        result = self.read()
        self.assertEqual(result["body"], self.server.body)
        self.assertEqual(result["etag"], "public-validator")
        self.assertTrue(result["complete"])
        self.assertEqual(self.server.requests[0][:2], ("GET", self.route["path"]))
        self.assertEqual(self.server.requests[0][2]["authorization"], "Bearer public-fixture")

    def test_gzip_is_retained_for_exact_bounded_decompression(self):
        expected = self.server.body
        self.server.body = gzip.compress(expected, mtime=12)
        self.server.headers.append(("Content-Encoding", "gzip"))
        result = self.read()
        self.assertEqual(result["body"], self.server.body)
        self.assertEqual(daily.body(result), expected)

    def test_wrong_route_request_hash_or_mutation_never_connects(self):
        changes = ({"method": "POST"}, {"request_sha256": "0" * 64},
                   {"path": "https://foreign.invalid/api/v3/comments"})
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                route = self.route | change
                capture.capture(self.endpoint, route, [route], self.headers)
        self.assertEqual(self.server.requests, [])

    def test_missing_inventory_and_header_injection_never_connect(self):
        with self.assertRaises(ValueError):
            capture.capture(self.endpoint, self.route, [], self.headers)
        for headers in (self.headers | {"host": "foreign.invalid"}, {"cookie": "value\r\nX-Injected: yes"}):
            with self.assertRaises(ValueError):
                capture.capture(self.endpoint, self.route, [self.route], headers)
        self.assertEqual(self.server.requests, [])

    def test_redirect_is_observed_without_following(self):
        self.server.status = 302
        self.server.headers.append(("Location", "https://foreign.invalid"))
        self.assertEqual(self.read()["status"], 302)
        self.assertEqual(len(self.server.requests), 1)

    def test_duplicate_headers_and_truncated_content_length_refuse(self):
        self.server.headers.append(("Content-Type", "text/plain"))
        with self.assertRaisesRegex(ValueError, "HEADERS"):
            self.read()
        self.server.headers = [("Content-Length", "100")]
        with self.assertRaises(ValueError):
            self.read()

    def test_oversized_declared_body_refuses(self):
        self.server.headers.append(("Content-Length", str(daily.MAX_BODY + 1)))
        with self.assertRaisesRegex(ValueError, "BODY"):
            self.read()

    def test_world_accessible_socket_and_wrong_uid_refuse(self):
        os.chmod(self.path, 0o606)
        with self.assertRaisesRegex(ValueError, "SOCKET"):
            self.read()
        os.chmod(self.path, 0o600)
        with self.assertRaisesRegex(ValueError, "SOCKET"):
            capture.capture(self.endpoint | {"uid": os.getuid() + 1}, self.route, [self.route], self.headers)

    def test_socket_symlink_and_same_reader_pair_refuse(self):
        alias = str(Path(self.temp.name) / "alias.sock")
        Path(alias).symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, "SOCKET"):
            capture.capture(self.endpoint | {"socket": alias}, self.route, [self.route], self.headers)
        with self.assertRaisesRegex(ValueError, "DISTINCT"):
            capture.pair(dict(clojure=self.endpoint, python=self.endpoint), self.route, [self.route], self.headers)

    def test_same_uid_wrong_reader_pid_refuses(self):
        with self.assertRaisesRegex(ValueError, "PEER"):
            capture.capture(self.endpoint | {"pid": os.getpid()+100000}, self.route, [self.route], self.headers)
        self.assertEqual(self.server.requests, [])

    def test_empty_304_does_not_claim_a_full_body_binding(self):
        self.server.status, self.server.body = 304, b""
        result = self.read()
        self.assertIsNone(result["full_body"])
        self.assertEqual(daily.compare(result, result, self.route), "INCOMPLETE")


if __name__ == "__main__":
    unittest.main()
