"""Test-only protocol drivers. Values bind through each real queue adapter."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import threading
from urllib.parse import urlsplit, urlunsplit

import psycopg2
from polismath.queue import executor as ex

ROOT = Path(__file__).resolve().parents[3]
BINARY = ROOT / "queue-rs/target/debug/polis-queue-adapter"
ENQUEUE_CASTS = ("text", "integer", "text", "text", "text", "text", "uuid", "uuid", "text", "text", "text", "text", "smallint", "integer")


def python_call(dsn, env, name, args):
    if name != "pq_enqueue":
        return ex.Database(ex.Settings(dsn, env)).call(name, args)
    # The existing executor owns consumption only. Producer-only enqueue uses
    # the same real psycopg connection, grants, policy and fixed wire validator.
    conn = psycopg2.connect(dsn, application_name="polis-queue-python-producer/1")
    try:
        with conn.cursor() as cur:
            cur.execute(ex._SESSION_POLICY)
            cur.execute(ex._BOUNDARY_SQL, [list(ex.QUEUE_TABLES)])
            assert cur.fetchone() == (True, False, False)
            cur.execute("SELECT public.pq_enqueue(" + ",".join("%s::" + t for t in ENQUEUE_CASTS) + ")", args)
            reply = ex.validate(cur.fetchone()[0])
        try:
            conn.commit()
        except psycopg2.Error as error:
            raise ex.CommitOutcomeUnknown(reply) from error
        return reply
    finally:
        conn.close()


class Driver:
    def __init__(self, language, dsn, env):
        self.language, self.dsn, self.env = language, dsn, env
        self.process = None
        if language == "rust":
            self.process = subprocess.Popen([str(BINARY)], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                env={**os.environ, "QUEUE_DATABASE_URL": dsn, "QUEUE_ENV": env})

    def call(self, name, args):
        if self.process is None:
            return python_call(self.dsn, self.env, name, args)
        self.process.stdin.write(json.dumps({"name": name, "args": args}) + "\n")
        self.process.stdin.flush()
        result = json.loads(self.process.stdout.readline())
        if "uncertain" in result:
            raise ex.CommitOutcomeUnknown(result["uncertain"])
        if "error" in result:
            raise RuntimeError(result)
        return result["reply"]

    def close(self):
        if self.process is not None:
            self.process.stdin.close()
            self.process.wait(timeout=10)
            assert self.process.returncode == 0, self.process.stderr.read()
            self.process.stdout.close()
            self.process.stderr.close()


class CommitProxy:
    """Intercept actual PG COMMIT frames for exactly one selected RPC.

    before=True drops COMMIT before the backend receives it (rollback window).
    Otherwise wait on CommandComplete(COMMIT), confirm durability independently,
    then sever both sockets before the client can see its acknowledgement.
    """
    def __init__(self, dsn, rpc, before=False):
        parsed = urlsplit(dsn)
        self.target = (parsed.hostname, parsed.port)
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.listener.settimeout(.1)
        self.url = urlunsplit(parsed._replace(netloc=f"{parsed.username}@127.0.0.1:{self.listener.getsockname()[1]}"))
        self.rpc = ("public." + rpc + "(").encode()
        self.before = before
        self.reached = threading.Event()
        self.release = threading.Event()
        self.stop = threading.Event()
        self.once = threading.Lock()
        self.sockets, self.threads, self.errors = [], [], []
        self.rpc_count = 0
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    @staticmethod
    def read(sock, n):
        data = b""
        while len(data) < n:
            part = sock.recv(n - len(data))
            if not part:
                raise EOFError
            data += part
        return data

    def frame(self, sock):
        kind, size = self.read(sock, 1), self.read(sock, 4)
        return kind, size, self.read(sock, struct.unpack("!I", size)[0] - 4)

    def cut(self, client, server):
        self.reached.set()
        if not self.release.wait(30):
            self.errors.append("barrier_not_released")
        for sock in (client, server):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def accept(self):
        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            server = socket.create_connection(self.target, timeout=5)
            server.settimeout(None)
            self.sockets.extend((client, server))
            thread = threading.Thread(target=self.relay, args=(client, server), daemon=True)
            self.threads.append(thread)
            thread.start()

    def relay(self, client, server):
        selected = threading.Event()
        def upstream():
            try:
                size = self.read(client, 4)
                body = self.read(client, struct.unpack("!I", size)[0] - 4)
                # Decline libpq's optional SSL request; this is loopback only.
                if body == struct.pack("!I", 80877103):
                    client.sendall(b"N")
                    size = self.read(client, 4)
                    body = self.read(client, struct.unpack("!I", size)[0] - 4)
                server.sendall(size + body)
                while True:
                    kind, size, body = self.frame(client)
                    if kind in (b"P", b"Q") and self.rpc in body:
                        selected.set()
                        self.rpc_count += 1
                    if self.before and selected.is_set() and kind == b"Q" and body.upper() == b"COMMIT\0" and self.once.acquire(False):
                        self.cut(client, server)
                        return
                    server.sendall(kind + size + body)
            except (EOFError, OSError):
                pass
        thread = threading.Thread(target=upstream, daemon=True)
        self.threads.append(thread)
        thread.start()
        try:
            while True:
                kind, size, body = self.frame(server)
                if not self.before and selected.is_set() and kind == b"C" and body == b"COMMIT\0" and self.once.acquire(False):
                    self.cut(client, server)
                    return
                client.sendall(kind + size + body)
        except (EOFError, OSError):
            pass

    def close(self):
        self.release.set()
        self.stop.set()
        self.listener.close()
        for sock in self.sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        self.thread.join(2)
        for thread in self.threads:
            thread.join(2)
        assert not self.errors


if __name__ == "__main__":
    # A real restartable psycopg child for process-death acknowledgement tests.
    request = json.loads(sys.stdin.readline())
    try:
        print(json.dumps({"reply": python_call(os.environ["QUEUE_DATABASE_URL"], os.environ["QUEUE_ENV"], request["name"], request["args"])}), flush=True)
    except ex.CommitOutcomeUnknown as error:
        print(json.dumps({"uncertain": error.reply}), flush=True)
