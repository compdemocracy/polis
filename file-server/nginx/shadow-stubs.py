#!/usr/bin/env python3
"""Stand-ins for the vote shadow's behaviour test (queue-rs/polis-api/conformance/nginx-shadow.sh).

Each runs in its own container on the test network:

  shadow-stubs.py node PORT          Node: records every request and answers 200
                                     with a body naming the request it received.
  shadow-stubs.py shadow PORT MODE   the shadow service, in one of its modes:
                                     answer   204 at once
                                     close    accepts and closes at once, unread
                                     silent   reads the request, never answers
                                     delay40  204 after 40 ms
                                     delay5s  204 after 5 s

Every request read is appended to /tmp/requests.jsonl: method, path, headers
in order (repeats kept), and the body's length and SHA-256. No vote is read.
"""
import hashlib
import json
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()


def record(entry):
    with LOCK, open('/tmp/requests.jsonl', 'a') as out:
        out.write(json.dumps(entry) + '\n')


def read_body(handler):
    if handler.headers.get('Transfer-Encoding', '').lower() == 'chunked':
        body = b''
        while True:
            size = int(handler.rfile.readline().split(b';')[0].strip() or b'0', 16)
            if size == 0:
                while handler.rfile.readline() not in (b'\r\n', b'\n', b''):
                    pass
                return body
            body += handler.rfile.read(size)
            handler.rfile.readline()
    return handler.rfile.read(int(handler.headers.get('Content-Length') or 0))


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    mode = 'node'

    def log_message(self, *args):
        pass

    def answer(self):
        body = read_body(self)
        digest = hashlib.sha256(body).hexdigest()
        record({'method': self.command, 'path': self.path,
                'headers': [[name.lower(), value] for name, value in self.headers.items()],
                'length': len(body), 'sha256': digest, 'at': time.time()})
        if self.mode == 'node':
            reply = f'node {self.command} {self.path} {digest}\n'.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(reply)))
            self.send_header('X-Upstream', 'server')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(reply)
            return
        if self.mode == 'silent':
            time.sleep(3600)
            return
        if self.mode == 'delay40':
            time.sleep(0.04)
        elif self.mode == 'delay5s':
            time.sleep(5)
        self.send_response(204)
        self.end_headers()

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_OPTIONS = answer


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    # A deep backlog, so the stand-in's own accept queue never adds latency.
    request_queue_size = 1024


def close_at_once(port):
    listener = socket.create_server(('0.0.0.0', port), backlog=1024)
    while True:
        connection, _ = listener.accept()
        connection.close()


def main():
    role, port = sys.argv[1], int(sys.argv[2])
    mode = sys.argv[3] if role == 'shadow' else 'node'
    if mode == 'close':
        close_at_once(port)
        return
    Handler.mode = mode
    Server(('0.0.0.0', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
