"""Bounded loopback-to-container stdio relay; the Docker network stays internal."""
import os
import select
import socketserver
import subprocess
import threading


class Tunnel:
    def __init__(self, port, argv):
        self.processes = set()
        self.lock = threading.Lock()
        self.limit = threading.BoundedSemaphore(64)
        owner = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                if not owner.limit.acquire(blocking=False):
                    return
                process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                with owner.lock:
                    owner.processes.add(process)
                try:
                    incoming = True
                    while True:
                        readable, _, _ = select.select(([self.request] if incoming else []) + [process.stdout], [], [])
                        if self.request in readable:
                            data = self.request.recv(65536)
                            if not data:
                                incoming = False
                                process.stdin.close()
                            else:
                                process.stdin.write(data)
                                process.stdin.flush()
                        if process.stdout in readable:
                            data = os.read(process.stdout.fileno(), 65536)
                            if not data:
                                break
                            self.request.sendall(data)
                except (OSError, ValueError):
                    pass
                finally:
                    process.kill()
                    process.wait()
                    with owner.lock:
                        owner.processes.discard(process)
                    owner.limit.release()

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.server = Server(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        with self.lock:
            for process in self.processes:
                process.kill()
        self.thread.join()
