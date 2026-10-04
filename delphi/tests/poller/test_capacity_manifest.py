"""The capacity manifest and its stores (polismath/poller/capacity_manifest.py,
P-073 PR3). Generated fixtures only. The filesystem backend runs for real;
the S3 backend runs through a real botocore client whose HTTP layer is
replaced by an in-memory object (the preconditions are checked on the request
botocore actually signs and sends), and against a throwaway MinIO when docker
is available."""

import json
import multiprocessing
import os
import shutil
import subprocess
import threading
import time
import uuid

import pytest

from polismath.poller import capacity_manifest as cm
from polismath.poller.capacity_manifest import (
    NOT_MODIFIED,
    Entry,
    FileManifestStore,
    Manifest,
    ManifestConflict,
    ManifestError,
    S3ManifestStore,
    Writer,
    open_store,
    parse,
)

T0 = 1_790_000_000_000


def manifest(generation=1, entries=(), restage=None, **writer):
    w = dict(label="python", binding="0123456789abcdef", run="abcdef012345",
             source_commit="a" * 40, small_capacity_bytes=900, large_budget_bytes=None)
    w.update(writer)
    return Manifest(generation=generation, written_ms=T0, writer=Writer(**w),
                    staged_label="python-large", entries=tuple(entries), restage=restage)


def entry(zid, **kw):
    base = dict(zid=zid, need_bytes=1000, votes=10, voters=3, comments=4,
                input_through_ms=T0, first_unresolved_ms=T0, exceeds_largest=False)
    base.update(kw)
    return Entry(**base)


# --------------------------------------------------------------------------- #
# The document
# --------------------------------------------------------------------------- #
class TestDocument:
    def test_round_trip(self):
        m = manifest(entries=[entry(7), entry(3, exceeds_largest=True, votes=None)],
                     restage="0" * 16)
        back = parse(m.encode())
        assert back == Manifest(generation=1, written_ms=T0, writer=m.writer,
                                staged_label="python-large",
                                entries=(entry(3, exceeds_largest=True, votes=None), entry(7)),
                                restage="0" * 16)
        body = json.loads(m.encode())
        assert set(body) == set(cm.TOP_KEYS)
        assert [e["zid"] for e in body["entries"]] == [3, 7]  # sorted

    def test_content_key_ignores_generation_and_time(self):
        a, b = manifest(generation=1), manifest(generation=9)
        assert a.content_key() == b.content_key()
        assert a.content_key() != manifest(entries=[entry(1)]).content_key()

    @pytest.mark.parametrize("mutate", [
        lambda b: b.update(schema="other/1"),
        lambda b: b.pop("restage"),
        lambda b: b.update(extra=1),
        lambda b: b.update(generation=-1),
        lambda b: b.update(generation=True),
        lambda b: b.update(staged_label=""),
        lambda b: b.update(staged_label="a b"),
        lambda b: b.update(restage="XYZ"),
        lambda b: b["writer"].update(binding="short"),
        lambda b: b["writer"].update(run="nothex!"),
        lambda b: b["writer"].update(source_commit="abc"),
        lambda b: b["writer"].update(small_capacity_bytes=-1),
        lambda b: b["writer"].pop("label"),
        lambda b: b["entries"].append(dict(b["entries"][0])),            # duplicate zid
        lambda b: b["entries"][0].update(exceeds_largest=0),
        lambda b: b["entries"][0].update(need_bytes="1"),
        lambda b: b["entries"][0].update(zid=None),
        lambda b: b["entries"][0].pop("votes"),
        lambda b: b.update(entries={}),
    ])
    def test_the_shape_is_closed(self, mutate):
        body = json.loads(manifest(entries=[entry(1)]).encode())
        mutate(body)
        with pytest.raises(ManifestError):
            parse(json.dumps(body).encode())

    def test_not_json_and_too_large(self):
        with pytest.raises(ManifestError):
            parse(b"{not json")
        with pytest.raises(ManifestError):
            parse(b" " * (cm.MAX_BYTES + 1))

    def test_entry_count_is_bounded(self):
        body = json.loads(manifest().encode())
        body["entries"] = [entry(i).as_dict() for i in range(cm.MAX_ENTRIES + 1)]
        with pytest.raises(ManifestError):
            parse(json.dumps(body).encode())


# --------------------------------------------------------------------------- #
# URIs
# --------------------------------------------------------------------------- #
class TestOpenStore:
    def test_schemes(self, tmp_path):
        s3 = open_store("s3://a-bucket/math-capacity/python/manifest.json", s3_client=object())
        assert isinstance(s3, S3ManifestStore)
        assert (s3.bucket, s3.key) == ("a-bucket", "math-capacity/python/manifest.json")
        f = open_store(f"file://{tmp_path}/m.json")
        assert isinstance(f, FileManifestStore) and f.path == f"{tmp_path}/m.json"
        assert isinstance(open_store(f"{tmp_path}/m.json"), FileManifestStore)

    @pytest.mark.parametrize("uri", ["", "relative/path.json", "s3://bucket-only", "s3:///key"])
    def test_refused(self, uri):
        with pytest.raises(ValueError):
            open_store(uri, s3_client=object())

    def test_describe_does_not_name_the_location(self, tmp_path):
        assert "a-bucket" not in open_store("s3://a-bucket/k", s3_client=object()).describe()
        assert str(tmp_path) not in open_store(f"{tmp_path}/m.json").describe()


# --------------------------------------------------------------------------- #
# The filesystem backend
# --------------------------------------------------------------------------- #
class TestFileStore:
    def test_create_then_conditional_update(self, tmp_path):
        store = FileManifestStore(str(tmp_path / "sub" / "manifest.json"))
        assert store.read() == (None, None)
        one = manifest(generation=1).encode()
        tag1 = store.write(one, None)
        assert store.read() == (one, tag1)
        assert store.read(tag1) is NOT_MODIFIED
        with pytest.raises(ManifestConflict):
            store.write(one, None)                       # create-only, it exists
        two = manifest(generation=2).encode()
        tag2 = store.write(two, tag1)
        assert tag2 != tag1 and store.read(tag1) == (two, tag2)
        with pytest.raises(ManifestConflict):
            store.write(manifest(generation=3).encode(), tag1)   # stale ETag
        assert store.read()[0] == two                   # nothing written

    def test_update_of_a_missing_object_conflicts(self, tmp_path):
        store = FileManifestStore(str(tmp_path / "m.json"))
        with pytest.raises(ManifestConflict):
            store.write(b"{}", '"x"')

    def test_etag_is_the_md5_s3_reports(self, tmp_path):
        store = FileManifestStore(str(tmp_path / "m.json"))
        raw = manifest().encode()
        import hashlib
        assert store.write(raw, None) == '"' + hashlib.md5(raw).hexdigest() + '"'

    def test_no_temporary_file_is_left(self, tmp_path):
        store = FileManifestStore(str(tmp_path / "m.json"))
        store.write(manifest().encode(), None)
        assert sorted(os.listdir(tmp_path)) == ["m.json", "m.json.lock"]

    def test_too_large_is_refused_before_writing(self, tmp_path):
        store = FileManifestStore(str(tmp_path / "m.json"))
        with pytest.raises(ManifestError):
            store.write(b" " * (cm.MAX_BYTES + 1), None)
        assert store.read() == (None, None)

    def test_concurrent_writers_from_one_etag_exactly_one_wins(self, tmp_path):
        store = FileManifestStore(str(tmp_path / "m.json"))
        tag = store.write(manifest(generation=1).encode(), None)
        results, barrier = [], threading.Barrier(8)

        def attempt(i):
            barrier.wait()
            try:
                store.write(manifest(generation=10 + i).encode(), tag)
                results.append("won")
            except ManifestConflict:
                results.append("lost")

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert results.count("won") == 1 and results.count("lost") == 7

    def test_concurrent_processes_exactly_one_wins(self, tmp_path):
        path = str(tmp_path / "m.json")
        tag = FileManifestStore(path).write(manifest(generation=1).encode(), None)
        ctx = multiprocessing.get_context("spawn")
        queue = ctx.Queue()
        procs = [ctx.Process(target=_process_writer, args=(path, tag, i, queue)) for i in range(4)]
        for p in procs:
            p.start()
        for p in procs:
            p.join(30)
        outcomes = sorted(queue.get(timeout=5) for _ in procs)
        assert outcomes.count("won") == 1 and outcomes.count("lost") == 3


def _process_writer(path, tag, i, queue):
    try:
        FileManifestStore(path).write(manifest(generation=20 + i).encode(), tag)
        queue.put("won")
    except ManifestConflict:
        queue.put("lost")


# --------------------------------------------------------------------------- #
# The S3 backend through a real botocore client (no network)
# --------------------------------------------------------------------------- #
class FakeS3:
    """One in-memory object behind botocore's HTTP layer: honours If-Match,
    If-None-Match on PUT and If-None-Match on GET as S3 does, and records the
    headers of every request botocore sends."""

    def __init__(self):
        self.body = None
        self.etag = None
        self.sent = []

    def handler(self, request, **_kw):
        from botocore.awsrequest import AWSResponse

        headers = {k: v for k, v in request.headers.items()}
        self.sent.append((request.method, headers))

        def respond(status, body=b"", extra=None):
            raw = _Raw(body)
            hdrs = {"Content-Length": str(len(body))}
            hdrs.update(extra or {})
            return AWSResponse(request.url, status, hdrs, raw)

        if request.method == "PUT":
            if_match = _hdr(headers, "If-Match")
            if_none = _hdr(headers, "If-None-Match")
            if if_none == "*" and self.body is not None:
                return respond(412, b"<Error><Code>PreconditionFailed</Code></Error>")
            if if_match is not None and if_match != self.etag:
                return respond(412, b"<Error><Code>PreconditionFailed</Code></Error>")
            body = request.body
            if hasattr(body, "read"):
                body = body.read()
            self.body = bytes(body)
            self.etag = cm.etag_of(self.body)
            return respond(200, b"", {"ETag": self.etag})
        if request.method == "GET":
            if self.body is None:
                return respond(404, b"<Error><Code>NoSuchKey</Code></Error>")
            if _hdr(headers, "If-None-Match") == self.etag:
                return respond(304)
            return respond(200, self.body, {"ETag": self.etag})
        return respond(405)


def _hdr(headers, name):
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v.decode() if isinstance(v, bytes) else v
    return None


class _Raw:
    def __init__(self, data):
        import io
        self._io = io.BytesIO(data)

    def stream(self, *_a, **_kw):
        data = self._io.read()
        if data:
            yield data

    def read(self, *a, **kw):
        return self._io.read(*a)

    def close(self):
        self._io.close()


@pytest.fixture
def s3():
    boto3 = pytest.importorskip("boto3")
    client = boto3.client("s3", region_name="us-east-1", aws_access_key_id="generated",
                          aws_secret_access_key="generated-secret")
    fake = FakeS3()
    client.meta.events.register("before-send.s3", fake.handler)
    return S3ManifestStore("generated-bucket", "math-capacity/python/manifest.json",
                           client=client), fake


class TestS3Store:
    def test_create_update_and_conflicts(self, s3):
        store, fake = s3
        assert store.read() == (None, None)
        one = manifest(generation=1).encode()
        tag1 = store.write(one, None)
        method, headers = fake.sent[-1]
        assert method == "PUT" and _hdr(headers, "If-None-Match") == "*"
        assert _hdr(headers, "If-Match") is None
        assert store.read() == (one, tag1)
        assert store.read(tag1) is NOT_MODIFIED
        with pytest.raises(ManifestConflict):
            store.write(one, None)
        two = manifest(generation=2).encode()
        tag2 = store.write(two, tag1)
        assert _hdr(fake.sent[-1][1], "If-Match") == tag1
        with pytest.raises(ManifestConflict):
            store.write(manifest(generation=3).encode(), tag1)
        assert store.read() == (two, tag2)

    def test_the_condition_is_signed_with_the_request(self, s3):
        store, fake = s3
        store.write(manifest().encode(), None)
        auth = _hdr(fake.sent[-1][1], "Authorization")
        assert "if-none-match" in auth.lower()

    def test_other_operations_are_untouched(self, s3):
        store, fake = s3
        store.write(manifest().encode(), None)
        store.read()
        method, headers = fake.sent[-1]
        assert method == "GET" and _hdr(headers, "If-Match") is None

    def test_install_is_idempotent(self, s3):
        store, _ = s3
        client = store.client
        assert cm.install_conditional_put(client) is client

    def test_other_errors_propagate(self):
        class Boom(Exception):
            response = {"Error": {"Code": "AccessDenied"}}

        class Client:
            meta = type("M", (), {"events": type("E", (), {"register": lambda *a, **k: None})()})()

            def put_object(self, **_kw):
                raise Boom()

            def get_object(self, **_kw):
                raise Boom()

        store = S3ManifestStore("b", "k", client=Client())
        with pytest.raises(Boom):
            store.write(b"{}", None)
        with pytest.raises(Boom):
            store.read()


# --------------------------------------------------------------------------- #
# The S3 backend against a throwaway MinIO (docker parity; self-skipping)
# --------------------------------------------------------------------------- #
MINIO_IMAGE = ("docker.io/bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:"
               "6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20")


@pytest.fixture(scope="module")
def minio():
    if os.environ.get("POLIS_TEST_MINIO") != "1":
        pytest.skip("set POLIS_TEST_MINIO=1 to run the MinIO parity test (needs docker)")
    docker = shutil.which("docker")
    if not docker:
        pytest.skip("docker not available")
    from tests.conftest import _free_tcp_port

    port = _free_tcp_port()
    name = f"delphi-manifest-minio-{uuid.uuid4().hex[:8]}"
    run = subprocess.run([docker, "run", "--rm", "-d", "--name", name, "-p", f"{port}:9000",
                          "-e", "MINIO_ROOT_USER=generated", "-e",
                          "MINIO_ROOT_PASSWORD=generated-secret",
                          "-e", "MINIO_DEFAULT_BUCKETS=generated-bucket", MINIO_IMAGE],
                         capture_output=True, text=True)
    if run.returncode != 0:
        pytest.skip(f"could not start minio: {run.stderr.strip()}")
    try:
        import boto3
        from botocore.config import Config

        client = boto3.client("s3", endpoint_url=f"http://127.0.0.1:{port}",
                              region_name="us-east-1", aws_access_key_id="generated",
                              aws_secret_access_key="generated-secret",
                              config=Config(s3={"addressing_style": "path"}))
        deadline = time.time() + 60
        while True:
            try:
                client.head_bucket(Bucket="generated-bucket")
                break
            except Exception:
                if time.time() > deadline:
                    pytest.skip("minio did not become ready")
                time.sleep(1)
        yield client
    finally:
        subprocess.run([docker, "rm", "-f", name], capture_output=True)


@pytest.mark.integration
def test_minio_honours_the_preconditions(minio):
    store = S3ManifestStore("generated-bucket", f"math-capacity/{uuid.uuid4().hex}/m.json",
                            client=minio)
    assert store.read() == (None, None)
    tag1 = store.write(manifest(generation=1).encode(), None)
    with pytest.raises(ManifestConflict):
        store.write(manifest(generation=1).encode(), None)
    assert store.read(tag1) is NOT_MODIFIED
    tag2 = store.write(manifest(generation=2).encode(), tag1)
    with pytest.raises(ManifestConflict):
        store.write(manifest(generation=3).encode(), tag1)
    raw, tag = store.read()
    assert tag == tag2 and parse(raw).generation == 2
