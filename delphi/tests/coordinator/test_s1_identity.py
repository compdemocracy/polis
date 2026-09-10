"""S1 original-byte custody and genuine severed COMMIT acknowledgement witnesses."""
import hashlib
import json
import socket
import struct
import threading
from urllib.parse import urlsplit, urlunsplit

import pytest
from coordinator.conftest import connect, rows, seed
from coordinator.test_store import fixture_file


@pytest.mark.parametrize("table", ["math_main", "math_bidtopid", "math_ptptstats"])
@pytest.mark.parametrize("corrupt", ["jsonb", "original", "original_with_digest", "digest"])
def test_original_jsonb_corruption_is_detected(db, launch, table, corrupt):
    seed(db)
    launch(db).done()
    c = connect(db)
    with c.cursor() as cur:
        if corrupt == "jsonb":
            cur.execute(f"UPDATE {table} SET data=data || '{{\"synthetic_corruption\":true}}'::jsonb")
        else:
            kind=table.removeprefix("math_")
            # First demonstrate the new database hash constraint, then remove
            # only that guard in this disposable corruption witness so the
            # independent Rust reader must still detect the forged state.
            cur.execute("SELECT conname FROM pg_constraint WHERE conrelid='polis_coordinator_payloads'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%sha256(original_bytes)%'")
            constraint=cur.fetchone()[0]
            with pytest.raises(Exception) as rejected:
                cur.execute("UPDATE polis_coordinator_payloads SET original_sha256=%s WHERE payload_kind=%s",("0"*64,kind))
            assert rejected.value.pgcode=="23514"
            cur.execute(f'ALTER TABLE polis_coordinator_payloads DROP CONSTRAINT "{constraint}"')
            if corrupt == "digest":
                cur.execute("UPDATE polis_coordinator_payloads SET original_sha256=%s WHERE payload_kind=%s",("0"*64,kind))
            else:
                cur.execute("SELECT original_bytes FROM polis_coordinator_payloads WHERE payload_kind=%s",(kind,))
                raw=json.loads(bytes(cur.fetchone()[0]));raw["synthetic_corruption"]=True
                raw=json.dumps(raw).encode()
                cur.execute("UPDATE polis_coordinator_payloads SET original_bytes=%s WHERE payload_kind=%s",(raw,kind))
                if corrupt == "original_with_digest":
                    digest=hashlib.sha256(raw).hexdigest()
                    cur.execute("UPDATE polis_coordinator_payloads SET original_sha256=%s WHERE payload_kind=%s",(digest,kind))
                    cur.execute("UPDATE polis_coordinator_generations SET input_checkpoint=jsonb_set(input_checkpoint,%s,to_jsonb(%s::text))",(["original_digests",kind],digest))
    c.close()
    launch(db, "read", args=(1,)).done(code=1)
    launch(db, extra={"P026_INCREMENTAL": "0"}).done()
    launch(db, "read", args=(1,)).done()


def test_exact_worker_bytes_and_numeric_spelling_survive_publication(db, launch, tmp_path):
    seed(db)
    launch(db).done()
    before = rows(db)
    payloads = {key: before["math_" + key]["data"] for key in ("main", "bidtopid", "ptptstats")}
    raw = {key: json.dumps(value, indent=2).encode() + b"\n" for key, value in payloads.items()}
    # A lexical representation which JSONB will erase, including negative zero.
    raw["main"] = raw["main"].rstrip()[:-1] + b', "synthetic_lexical": [-0.0, 1e-7, 1.000]}\n'
    payloads["originals"] = {key: list(value) for key, value in raw.items()}
    launch(db, "publish-fixture", args=(fixture_file(tmp_path, payloads, expected=0),)).done()
    out, _ = launch(db, "read", args=(1,)).done()
    bundle = json.loads(out)
    current = rows(db)
    for key, original in raw.items():
        row = current["math_" + key]
        assert bytes(row["original_bytes"]) == original
        assert bytes(bundle["payloads"]["originals"][key]) == original
        assert row["original_sha256"] == hashlib.sha256(original).hexdigest()
        assert json.loads(original) == row["data"]
    assert bundle["publisher_epoch"] == current["math_ticks"]["publisher_epoch"]
    assert bundle["operation_id"] == current["math_ticks"]["operation_id"]


class CommitProxy:
    """Loopback PG wire relay: swallow the publication's actual COMMIT reply.

    No coordinator fault stage or Python worker patch: observe Parse/Query frames
    for math_ticks, then drop CommandComplete(COMMIT) on that connection. The
    backend has committed; the coordinator remains awaiting its reply until release.
    Subsequent connections (including readback and heartbeat) pass through.
    """
    def __init__(self, db, query=b"SELECT * FROM public.pc_publish("):
        self.query = query
        parsed = urlsplit(db)
        self.target = (parsed.hostname, parsed.port)
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.listener.settimeout(.2)
        self.url = urlunsplit(parsed._replace(netloc=f"postgres@127.0.0.1:{self.listener.getsockname()[1]}"))
        self.reject_connections = False
        self.committed = threading.Event()
        self.release = threading.Event()
        self.stop = threading.Event()
        self.claim = threading.Lock()
        self.sockets = []
        self.errors = []
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    @staticmethod
    def read(sock, size):
        result = b""
        while len(result) < size:
            part = sock.recv(size - len(result))
            if not part:
                raise EOFError
            result += part
        return result

    def accept(self):
        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if self.reject_connections:
                client.close()
                continue
            server = socket.create_connection(self.target, timeout=10)
            server.settimeout(None)
            self.sockets.extend([client, server])
            threading.Thread(target=self.relay, args=(client, server), daemon=True).start()

    def relay(self, client, server):
        publication = threading.Event()
        def upstream():
            try:
                # No TLS in this synthetic trust-authenticated fixture.
                size = self.read(client, 4)
                server.sendall(size + self.read(client, struct.unpack("!I", size)[0] - 4))
                while True:
                    kind = self.read(client, 1)
                    size = self.read(client, 4)
                    body = self.read(client, struct.unpack("!I", size)[0] - 4)
                    if kind in (b"P", b"Q") and self.query in body:
                        publication.set()
                    server.sendall(kind + size + body)
            except (EOFError, OSError):
                pass
        threading.Thread(target=upstream, daemon=True).start()
        try:
            while True:
                kind = self.read(server, 1)
                size = self.read(server, 4)
                body = self.read(server, struct.unpack("!I", size)[0] - 4)
                if (kind == b"C" and body == b"COMMIT\0" and publication.is_set()
                        and self.claim.acquire(blocking=False)):
                    self.committed.set()
                    if not self.release.wait(60):
                        self.errors.append("COMMIT release missing")
                    client.shutdown(socket.SHUT_RDWR)
                    server.shutdown(socket.SHUT_RDWR)
                    return
                client.sendall(kind + size + body)
        except (EOFError, OSError):
            pass

    def close(self):
        self.release.set()
        self.stop.set()
        self.listener.close()
        for sock in self.sockets:
            sock.close()
        self.thread.join(2)


@pytest.mark.parametrize("replacement", [False, True])
def test_uncertain_commit_readback_binds_publishing_epoch(db, launch, tmp_path, replacement):
    seed(db)
    proxy = CommitProxy(db)
    try:
        metrics = tmp_path / "outcomes.jsonl"
        child = launch(proxy.url, extra={"P026_METRICS": str(metrics)})
        assert proxy.committed.wait(30), "publication COMMIT not intercepted"
        original = rows(db)
        assert original["math_ticks"]["math_tick"] == 0
        if replacement:
            # New receipts reject reuse of an operation by a different epoch.
            # A genuine later publication leaves the first receipt intact.
            c=connect(db)
            with c.cursor() as cur:
                cur.execute("UPDATE polis_coordinator_leases SET expires_at=clock_timestamp()-interval '1 second'")
            c.close()
            payloads={key:original["math_"+key]["data"] for key in ("main","bidtopid","ptptstats")}
            path=fixture_file(tmp_path,payloads,expected=0)
            launch(db,"publish-fixture",args=(path,)).done()
            successor=rows(db)
            assert successor["math_ticks"]["math_tick"]==1
            assert successor["math_ticks"]["publisher_epoch"]>original["math_ticks"]["publisher_epoch"]
            assert successor["math_ticks"]["operation_id"]!=original["math_ticks"]["operation_id"]
            assert successor["math_main"]["data"]==original["math_main"]["data"]
        proxy.release.set()
        out, err = child.done(code=0)
        if replacement:
            assert rows(db) == successor
        else:
            assert json.loads(out)["published"] == 1
            assert rows(db) == original
        from coordinator.test_publication_metrics import assert_outcome
        assert_outcome(metrics, original, own=True)
        assert not proxy.errors
    finally:
        proxy.close()
