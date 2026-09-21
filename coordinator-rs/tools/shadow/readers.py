"""Own two disposable original-application readers and their private sockets."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import time

import daily


@contextmanager
def launch(profile, snapshot, database, directory):
    daily.closed(profile, ("node", "node_sha256", "bootstrap", "bootstrap_sha256",
                          "pool_sha256", "common", "clojure_namespace", "python_namespace"))
    node, bootstrap = Path(profile["node"]), Path(profile["bootstrap"])
    for path, digest in ((node, profile["node_sha256"]),
                         (bootstrap, profile["bootstrap_sha256"]),
                         (bootstrap.parent / "snapshot-pool.cjs", profile["pool_sha256"])):
        if (not path.is_absolute() or path.is_symlink() or not daily.SHA.fullmatch(digest)
                or hashlib.sha256(path.read_bytes()).hexdigest() != digest):
            raise ValueError("SHADOW_READER_BINARY")
    if profile["clojure_namespace"] == profile["python_namespace"]:
        raise ValueError("SHADOW_NAMESPACE")
    daily.closed(profile["common"], ("app_root", "app_entry", "build_manifest",
        "dependency_manifest", "node_build", "node_dependencies", "settings", "node_settings", "requests"))
    root = Path(directory)
    if not root.is_absolute() or root.is_symlink() or root.exists():
        raise ValueError("SHADOW_READER_DIRECTORY")
    root.mkdir(mode=0o700)
    processes, endpoints, ready = [], {}, {}
    try:
        for engine in ("clojure", "python"):
            socket_path = root / (engine + ".sock")
            private_profile = root / (engine + ".json")
            body = dict(profile["common"], schema="polis-shadow-reader/1", snapshot=snapshot,
                        namespace=profile[engine + "_namespace"], database_host=database["host"],
                        socket=str(socket_path))
            fd = os.open(private_profile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(daily.canonical(body))
                stream.flush()
                os.fsync(stream.fileno())
            env = {"PATH": str(node.parent), "SHADOW_READER_ENABLE": "1",
                   "SHADOW_READER_PROFILE": str(private_profile),
                   "SHADOW_READER_DATABASE_URL": database["url"],
                   "SHADOW_READER_PASSWORD_FILE": database["password_file"],
                   "SHADOW_READER_CA_FILE": database["ca_file"]}
            process = subprocess.Popen([str(node), str(bootstrap)], env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            processes.append(process)
            data = bytearray()
            deadline = time.monotonic() + 30
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while b"\n" not in data:
                    if time.monotonic() >= deadline or process.poll() is not None or len(data) > 16384:
                        raise ValueError("SHADOW_READER_START")
                    if selector.select(.1):
                        chunk = os.read(process.stdout.fileno(), 16385 - len(data))
                        if not chunk:
                            raise ValueError("SHADOW_READER_START")
                        data.extend(chunk)
            row = json.loads(data)
            expected = dict(schema="polis-shadow-reader-ready/1", pid=process.pid,
                namespace=body["namespace"], snapshot=snapshot,
                **{k: body[k] for k in ("node_build", "node_dependencies", "node_settings")})
            if row != expected:
                raise ValueError("SHADOW_READER_BINDING")
            ready[engine] = row
            endpoints[engine] = dict(socket=str(socket_path), uid=os.getuid(), pid=process.pid)
        yield endpoints, ready
        if any(process.poll() is not None for process in processes):
            raise ValueError("SHADOW_READER_LOST")
    finally:
        for process in processes:
            if process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                except ProcessLookupError:
                    process.wait()
            process.stdout.close()
        # Only owned ephemeral reader profiles and sockets are removed. Private
        # cut/replay custody files elsewhere retain their independent lifetime.
        for engine in ("clojure", "python"):
            for suffix in (".json", ".sock"):
                (root / (engine + suffix)).unlink(missing_ok=True)
        root.rmdir()
