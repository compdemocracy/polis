"""Socket-only access from the reader container to the fixed TLS replica."""
from __future__ import annotations
import select
import socket
import ssl
import struct
import threading
from pathlib import Path


class ReplicaSocket:
    def __init__(self, directory: Path, host: str, ca: Path):
        self.directory, self.host, self.ca = directory, host, ca
        self.stop = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(directory / '.s.PGSQL.5432'))
        (directory / '.s.PGSQL.5432').chmod(0o666)
        self.listener.listen(4)
        self.listener.settimeout(1)
        self.children: list[threading.Thread] = []
        self.thread = threading.Thread(target=self.serve, daemon=True)
        # Counts per relay outcome class; the only thing this relay ever reports.
        self.outcomes: dict[str, int] = {}
        self.lock = threading.Lock()

    def summary(self) -> dict[str, int]:
        with self.lock:
            return dict(self.outcomes)

    def serve(self) -> None:
        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            child = threading.Thread(target=self.relay, args=(client,), daemon=True)
            self.children.append(child)
            child.start()

    def relay(self, client: socket.socket) -> None:
        outcome = 'relayed'
        try:
            with client:
                try:
                    upstream = socket.create_connection((self.host, 5432), timeout=5)
                except socket.gaierror:
                    outcome = 'resolve'
                    return
                except OSError:
                    outcome = 'connect'
                    return
                with upstream:
                    upstream.sendall(struct.pack('!II', 8, 80877103))
                    if upstream.recv(1) != b'S':
                        outcome = 'no_tls'
                        return
                    context = ssl.create_default_context(cafile=str(self.ca))
                    try:
                        secure = context.wrap_socket(upstream, server_hostname=self.host)
                    except ssl.SSLCertVerificationError:
                        outcome = 'tls_verify'
                        return
                    except (OSError, ssl.SSLError):
                        outcome = 'tls'
                        return
                    with secure:
                        while not self.stop.is_set():
                            ready, _, _ = select.select([client, secure], [], [], 1)
                            for source in ready:
                                data = source.recv(65536)
                                if not data:
                                    return
                                (secure if source is client else client).sendall(data)
        except (OSError, ssl.SSLError):
            outcome = 'io'
        finally:
            with self.lock:
                self.outcomes[outcome] = self.outcomes.get(outcome, 0) + 1

    def __enter__(self) -> 'ReplicaSocket':
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop.set()
        self.listener.close()
        self.thread.join(timeout=6)
        for child in self.children:
            child.join(timeout=6)
