"""The large worker's real boot path, rehearsed on a build box (P-073 r2, #722, #671).

Not collected by pytest: a script run on a build box with Docker. It starts
the worker the way a math-large box does, from the pieces production uses:

  * the FINAL Delphi image (``--image``, built from this tree with
    ``docker build --target final``), which carries the polis-jobs daemon;
  * the unit, its start script and the env document exactly as the launch
    template writes them (``cdk/scripts/emit-worker-files.ts``, ``--worker-files``),
    installed at their real paths in a stand-in box (systemd as PID 1,
    ``worker_boot/Dockerfile.box``) and started with ``systemctl start``;
  * a restricted queue login (a member of ``polis_queue_executor`` only)
    whose password the start script reads BY NAME from a stand-in secret store
    (``worker_boot/aws-standin``: a local file, clearly marked, never AWS);
  * TLS to Postgres verified against the CA file the env document names
    (a local stand-in CA in place of the RDS bundle) and the host allowlist;
  * a shared app ``.env`` that carries what production's carries for the
    small poller: the SERVED label ``MATH_ENV=python``, routing on, and the
    deploy hook's ``MATH_POLLER_SOURCE_COMMIT``. The env document must
    override the label: this script never sets the child's label itself.

What it proves, each step asserted and printed:

  1. the daemon starts under systemd, reads the login from the named secret,
     connects over TLS (pg_stat_ssl) as the restricted login;
  2. the child runs with MATH_ENV=python-large (the env document won over the
     app .env), its memory budget from the unit's cgroup, and the frame's
     source commit equal to the deploy's; a routed conversation is admitted
     by the real small-poller code, computed and staged; the receipt binds it;
  3. without MATH_POLLER_SOURCE_COMMIT in .env the unit refuses to start the
     daemon (nothing is claimed);
  4. a frame staged for another label is refused by the child (exit 2);
  5. with migration 000025 in the tree: a database declaring a vote convention
     this build was not made for (agree = +1) is refused by the child (exit 2,
     the mismatch refusal) through the same unit.

Generated data only (one made-up conversation per database). Every container,
network and directory it creates is removed at the end.

Usage (on the build box, repository root; the image and files built first):

  docker build -t polis-proof/delphi:final --target final \\
      --build-context queue-rs=queue-rs delphi
  (cd cdk && npx ts-node scripts/emit-worker-files.ts --out $W/files \\
      --image polis-proof/delphi:final --queue-hosts PLACEHOLDER)
  PYTHONPATH=delphi delphi/.venv/bin/python delphi/tests/poller/worker_boot_proof.py \\
      --image polis-proof/delphi:final --worker-files $W/files --work $W/run \\
      --commit $(git rev-parse HEAD) --project wbp

``--queue-hosts`` is rewritten here to the proof database's address (the
stack writes the RDS endpoint); every other line of the env document is used
as written. ``--work`` must be under a directory the Docker VM mounts.
Exit 0 iff every step held.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import time
import uuid
from pathlib import Path

MB = 1024 * 1024
SMALL, STAGED = "python", "python-large"
LOGIN = "polis_jobs_proof"
SECRET_NAME = "polis-queue-login"
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
T0 = time.time()


def say(step: str, message: str) -> None:
    print(f"[{time.time() - T0:7.1f}s] {step}: {message}", flush=True)


def check(step: str, condition: bool, message: str) -> None:
    say(step, ("ok   " if condition else "FAIL ") + message)
    if not condition:
        raise SystemExit(f"worker boot proof failed at {step}: {message}")


def sh(*args: str, check_rc: bool = True, input_bytes: bytes | None = None) -> str:
    p = subprocess.run(list(args), capture_output=True, input=input_bytes)
    if check_rc and p.returncode != 0:
        raise SystemExit(f"command failed ({p.returncode}): {' '.join(args)}\n"
                         f"{p.stdout.decode(errors='replace')[-2000:]}\n"
                         f"{p.stderr.decode(errors='replace')[-2000:]}")
    return p.stdout.decode(errors="replace")


def read_env(path: Path) -> list[tuple[str, str]]:
    out = []
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            k, _, v = line.partition("=")
            out.append((k, v))
    return out


def write_env(path: Path, pairs: list[tuple[str, str]]) -> None:
    path.write_text("".join(f"{k}={v}\n" for k, v in pairs))


class Proof:
    def __init__(self, args) -> None:
        self.args = args
        self.p = args.project
        self.work = Path(args.work).resolve()
        self.pg = f"{self.p}-pg"
        self.box = f"{self.p}-box"
        self.box_image = f"{self.p}-box:proof"
        self.pg_port = args.pg_port
        self.pg_password = secrets.token_hex(12)
        self.login_password = secrets.token_hex(16)
        self.migrations = sorted((REPO / "server/postgres/migrations").glob("0*.sql"))
        self.has_convention = any(m.name.startswith("000025_") for m in self.migrations)

    # ------------------------------------------------------------- database
    def psql(self, db: str, sql: str | None = None, file: Path | None = None,
             variables: dict | None = None) -> str:
        cmd = ["docker", "exec", "-i", self.pg, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1",
               "-U", "postgres", "-d", db]
        for k, v in (variables or {}).items():
            cmd += ["-v", f"{k}={v}"]
        if sql is not None:
            cmd += ["-c", sql]
            return sh(*cmd)
        return sh(*cmd, input_bytes=file.read_bytes())

    def start_postgres(self) -> None:
        sh("docker", "run", "-d", "--name", self.pg, "-e", f"POSTGRES_PASSWORD={self.pg_password}",
           "-p", f"127.0.0.1:{self.pg_port}:5432", "postgres:17")
        for _ in range(60):
            if subprocess.run(["docker", "exec", self.pg, "pg_isready", "-U", "postgres"],
                              capture_output=True).returncode == 0:
                break
            time.sleep(1)
        time.sleep(2)
        self.pg_ip = sh("docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", self.pg).strip()
        check("setup", bool(self.pg_ip), f"postgres:17 at {self.pg_ip} (default bridge, where the "
                                         "unit's docker run puts the daemon)")
        # A stand-in CA (in place of the RDS bundle) and a server certificate for that address.
        certs = self.work / "certs"
        certs.mkdir(parents=True, exist_ok=True)
        sh("docker", "run", "--rm", "-v", f"{certs}:/w", "postgres:17", "bash", "-c",
           "set -e; cd /w; "
           "openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=worker-boot-proof stand-in CA' "
           "-keyout ca.key -out ca.pem >/dev/null 2>&1; "
           "openssl req -newkey rsa:2048 -nodes -subj '/CN=queue-db' -keyout server.key -out server.csr "
           ">/dev/null 2>&1; "
           f"printf 'subjectAltName=IP:{self.pg_ip},IP:127.0.0.1\\n' > ext.cnf; "
           "openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 "
           "-extfile ext.cnf -out server.crt >/dev/null 2>&1; chmod 644 *")
        for f in ("server.crt", "server.key"):
            sh("docker", "cp", str(certs / f), f"{self.pg}:/var/lib/postgresql/{f}")
        sh("docker", "exec", "-u", "root", self.pg, "bash", "-c",
           "chown postgres:postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key")
        self.psql("postgres", "ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/server.crt'")
        self.psql("postgres", "ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/server.key'")
        self.psql("postgres", "ALTER SYSTEM SET ssl=on")
        self.psql("postgres", "SELECT pg_reload_conf()")
        time.sleep(1)
        check("setup", self.psql("postgres", "SHOW ssl").strip() == "on", "TLS on, stand-in CA")
        self.ca_pem = certs / "ca.pem"
        self.psql("postgres", f"CREATE ROLE {LOGIN} LOGIN PASSWORD '{self.login_password}'")

    def make_database(self, name: str, agree: int | None) -> int:
        """Migrations 000000.., one generated conversation, then (with 000025)
        the convention declared ``agree``. Returns the conversation's zid."""
        self.psql("postgres", f"CREATE DATABASE {name}")
        before = [m for m in self.migrations if not m.name.startswith("000025_")]
        for m in before:
            self.psql(name, file=m)
        self.psql(name, f"GRANT polis_queue_executor TO {LOGIN}")
        sys.path.insert(0, str(REPO / "delphi"))
        import psycopg2
        from tests.poller.test_backfill_postgres import seed_conversation
        zid = 40000 + (uuid.uuid4().int % 50000)
        conn = psycopg2.connect(self.dsn(name))
        conn.autocommit = True
        seed_conversation(conn, zid, participants=80, comments=30)
        conn.close()
        if self.has_convention:
            m25 = next(m for m in self.migrations if m.name.startswith("000025_"))
            self.psql(name, file=m25)
            self.psql(name, file=REPO / "server/postgres/operations/vote_convention_declare.sql",
                      variables={"agree": str(agree), "reason": "worker boot proof (generated data)"})
            got = self.psql(name, "SELECT agree_value FROM public.vote_convention").strip()
            say("setup", f"{name}: 000025 applied after the votes; declared agree={got}")
        return zid

    def dsn(self, db: str, user: str = "postgres", password: str | None = None) -> str:
        pw = self.pg_password if password is None else password
        return f"postgresql://{user}:{pw}@127.0.0.1:{self.pg_port}/{db}?sslmode=disable"

    # ------------------------------------------------------------------ box
    def start_box(self) -> None:
        sh("docker", "build", "-q", "-t", self.box_image, "-f", str(HERE / "worker_boot/Dockerfile.box"),
           str(HERE / "worker_boot"))
        # The unit's docker run names host paths: those resolve on the docker
        # VM, so the box shares them with the VM at the same paths.
        self.vm_dirs = ["/run/polis-jobs", "/var/lib/polis-jobs", "/etc/polis-jobs"]
        mounts = []
        for d in self.vm_dirs:
            mounts += ["-v", f"{d}:{d}"]
        # /run is a tmpfs before systemd starts, so systemd keeps it and the
        # binds below it (the docker socket, /run/polis-jobs) stay visible.
        sh("docker", "run", "-d", "--name", self.box, "--privileged", "--cgroupns=host",
           "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", "--tmpfs", "/run", "--tmpfs", "/run/lock",
           "-v", "/var/run/docker.sock:/run/docker.sock", "--tmpfs", "/tmp", *mounts, self.box_image)
        for _ in range(60):
            state = subprocess.run(["docker", "exec", self.box, "systemctl", "is-system-running"],
                                   capture_output=True, text=True).stdout.strip()
            if state in ("running", "degraded"):
                break
            time.sleep(1)
        check("setup", state in ("running", "degraded"), f"stand-in box: systemd {state}")

    def box_sh(self, script: str, check_rc: bool = True) -> str:
        return sh("docker", "exec", self.box, "bash", "-c", script, check_rc=check_rc)

    def install(self, db: str, env_name: str, *, commit: str | None) -> None:
        files = Path(self.args.worker_files)
        doc = [(k, self.pg_ip if k == "POLIS_JOBS_HOST_ALLOWLIST" else v)
               for k, v in read_env(files / "polis-jobs.env")]
        self.doc = dict(doc)
        stage = self.work / "box"
        stage.mkdir(parents=True, exist_ok=True)
        write_env(stage / "polis-jobs.env", doc)
        app = [
            ("DATABASE_URL", f"postgresql://postgres:{self.pg_password}@{self.pg_ip}:5432/{db}"),
            ("DATABASE_SSL_MODE", "require"),
            ("MATH_ENV", SMALL),               # the served label, as production's .env
            ("MATH_CAPACITY_ROUTING", "1"),    # the small poller's setting, as production's .env
            ("QUEUE_DATABASE_URL", f"postgresql://{LOGIN}@{self.pg_ip}:5432/{db}"),
            ("QUEUE_ENV", env_name),
            ("POLIS_JOBS_POLL_SECONDS", "1"),
            ("POLIS_JOBS_READINESS_SECONDS", "2"),
            ("MATH_POLLER_INSTANCE_ID", "i-0workerbootproof"),
            ("LOG_LEVEL", "INFO"),
        ]
        if commit is not None:
            app.append(("MATH_POLLER_SOURCE_COMMIT", commit))   # as the deploy hook appends it
        write_env(stage / "app.env", app)
        (stage / f"{SECRET_NAME}.json").write_text(json.dumps({"username": LOGIN,
                                                                "password": self.login_password}))
        for src, dst in ((files / "polis-jobs.service", "/etc/systemd/system/polis-jobs.service"),
                         (files / "polis-jobs-start", "/usr/local/bin/polis-jobs-start"),
                         (stage / "polis-jobs.env", "/etc/app-info/polis-jobs.env"),
                         (stage / "app.env", "/opt/polis/polis/.env"),
                         (stage / f"{SECRET_NAME}.json", f"/srv/standin-secret-store/{SECRET_NAME}.json"),
                         (self.ca_pem, self.doc["POLIS_JOBS_CA_FILE"])):
            sh("docker", "cp", str(src), f"{self.box}:{dst}")
        self.box_sh("chmod 755 /usr/local/bin/polis-jobs-start && chmod 644 /etc/app-info/polis-jobs.env "
                    f"\"{self.doc['POLIS_JOBS_CA_FILE']}\" && systemctl daemon-reload")

    def unit_active(self) -> str:
        return self.box_sh("systemctl is-active polis-jobs.service", check_rc=False).strip()

    def journal(self) -> str:
        return self.box_sh("journalctl -u polis-jobs.service --no-pager -o cat | tail -n 40",
                           check_rc=False)

    def daemon_logs(self) -> str:
        p = subprocess.run(["docker", "logs", "polis-jobs"], capture_output=True, text=True)
        return p.stdout + p.stderr

    def wait_daemon_ready(self, secs: float = 90) -> None:
        deadline = time.time() + secs
        while time.time() < deadline:
            if "polis_jobs readiness/1" in self.daemon_logs():
                return
            time.sleep(1)
        raise SystemExit("the daemon logged no readiness line:\n" + self.journal()
                         + self.daemon_logs()[-3000:])

    def stop_unit(self) -> None:
        self.box_sh("systemctl stop polis-jobs.service", check_rc=False)
        sh("docker", "rm", "-f", "polis-jobs", check_rc=False)

    def cleanup(self) -> None:
        if self.args.keep:
            say("cleanup", "kept (--keep)")
            return
        self.stop_unit()
        sh("docker", "rm", "-f", self.box, self.pg, check_rc=False)
        if hasattr(self, "vm_dirs"):
            vols = sum((["-v", f"{d}:/x{i}"] for i, d in enumerate(self.vm_dirs)), [])
            sh("docker", "run", "--rm", *vols, "alpine", "sh", "-c", "rm -rf /x0/* /x1/* /x2/*",
               check_rc=False)
        sh("docker", "run", "--rm", "-v", "/run:/r", "-v", "/var/lib:/l", "-v", "/etc:/e", "alpine", "sh", "-c",
           "rmdir /r/polis-jobs /l/polis-jobs /e/polis-jobs 2>/dev/null; true", check_rc=False)
        sh("docker", "rmi", self.box_image, check_rc=False)
        say("cleanup", f"removed {self.box}, {self.pg}, the box image and the VM paths "
                       "/run/polis-jobs, /var/lib/polis-jobs, /etc/polis-jobs")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="the final Delphi image tag")
    ap.add_argument("--worker-files", required=True, help="cdk/scripts/emit-worker-files.ts --out")
    ap.add_argument("--work", required=True, help="scratch directory the Docker VM mounts")
    ap.add_argument("--commit", required=True, help="the source commit the image was built from")
    ap.add_argument("--project", default="wbp", help="prefix for container names")
    ap.add_argument("--pg-port", type=int, default=55871)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    sys.path.insert(0, str(REPO / "delphi"))
    os.environ["MATH_POLLER_SOURCE_COMMIT"] = args.commit
    from polismath.database.postgres import PostgresClient, PostgresConfig
    from polismath.poller import capacity_queue as cq
    from polismath.poller.admission import MemoryAdmission, MemoryModel, read_conversation_sizes
    from polismath.poller.capacity import CapacityRouter, CapacitySettings
    from polismath.poller.promotion import SmallCapacityLoop
    from polismath.poller.service import MathPollerService, PollerConfig

    proof = Proof(args)
    doc = dict(read_env(Path(args.worker_files) / "polis-jobs.env"))
    check("setup", doc.get("MATH_ENV") == STAGED and doc.get("POLIS_JOBS_IMAGE") == args.image,
          f"env document from the launch template: MATH_ENV={doc.get('MATH_ENV')} "
          f"image={doc.get('POLIS_JOBS_IMAGE')} CA={doc.get('POLIS_JOBS_CA_FILE')}")
    try:
        proof.start_postgres()
        zid_ok = proof.make_database("proof_ok", -1)
        zid_bad = proof.make_database("proof_mismatch", 1) if proof.has_convention else None
        proof.start_box()

        def small_poller(db: str, env_name: str, *, staged: str = STAGED):
            pg = PostgresClient(PostgresConfig(url=proof.dsn(db), math_env=SMALL, ssl_mode="disable"))
            pg.initialize()
            model = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                                job_floor_mb=0)
            adm = MemoryAdmission(1000 * MB, model, headroom=0.0, base_bytes=100 * MB)
            settings = CapacitySettings(routing=True, promote=False, staged_label=staged)
            router = CapacityRouter(adm, settings)
            svc = MathPollerService(pg, PollerConfig(database_url=proof.dsn(db), math_env=SMALL,
                                                     memory_limit_mb=1000),
                                    admission=adm, capacity=router)
            queue = cq.QueueClient(cq.QueueSettings(
                dsn=proof.dsn(db, LOGIN, proof.login_password), env=env_name))
            loop = SmallCapacityLoop(svc, router, settings, queue=queue, source_commit=args.commit)
            return pg, router, queue, loop

        def admit(db: str, env_name: str, zid: int, *, staged: str = STAGED):
            pg, router, queue, loop = small_poller(db, env_name, staged=staged)
            router.observe(zid, sizes=read_conversation_sizes(pg, zid), input_ms=int(time.time() * 1000))
            loop.tick()
            job = router.record(zid).job_id
            check("admit", job is not None and queue.job_status(job)["state"] == "queued",
                  f"{db}: the small poller's code admitted job {job[:8]} for zid={zid} "
                  f"(staged_label={staged}, source_commit={args.commit[:12]})")
            return pg, queue, job

        def attempts(db: str, job: str):
            return proof.psql(db, "SELECT outcome, coalesce(error_code,'') FROM polis_queue_attempts "
                                  f"WHERE job_id='{job}' ORDER BY lease_epoch").strip().splitlines()

        def child_lines(db: str, job: str) -> str:
            return proof.psql(db, "SELECT l.line FROM polis_queue_logs l JOIN polis_queue_attempts a ON "
                                  "a.env=l.env AND a.attempt_id=l.attempt_id "
                                  f"WHERE a.job_id='{job}' ORDER BY a.lease_epoch, l.seq")

        def wait_job(queue, job: str, until, secs: float = 240):
            deadline = time.time() + secs
            while time.time() < deadline:
                st = queue.job_status(job)
                if until(st):
                    return st
                time.sleep(1)
            raise SystemExit(f"job {job[:8]} state {queue.job_status(job)['state']}:\n"
                             + proof.journal() + "\n" + proof.daemon_logs()[-3000:])

        # --------------------------------------------------------------- 1
        env_ok = f"wbp-{uuid.uuid4().hex[:6]}"
        proof.install("proof_ok", env_ok, commit=args.commit)
        proof.box_sh("systemctl start polis-jobs.service")
        proof.wait_daemon_ready()
        check("1 unit", proof.unit_active() == "active", "polis-jobs.service active under systemd")
        reads = proof.box_sh("cat /srv/standin-secret-store/reads.log")
        check("1 secret", f"secret-id={SECRET_NAME}" in reads,
              f"the start script read the login by name from the stand-in store: {reads.strip()}")
        ssl = proof.psql("proof_ok", "SELECT s.ssl, s.version, a.usename FROM pg_stat_activity a JOIN "
                                     "pg_stat_ssl s USING (pid) WHERE a.application_name='polis-jobs/1'")
        check("1 tls", ssl.startswith("t|TLS") and LOGIN in ssl,
              f"the daemon's session: {ssl.strip()} (TLS, verified against the env document's CA "
              f"file and allowlist {proof.pg_ip})")
        rights = proof.psql("proof_ok", f"SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles "
                                        f"WHERE rolname='{LOGIN}'").strip()
        check("1 login", rights == "f|f|f", f"{LOGIN} is a plain login, member of polis_queue_executor")
        env_seen = sh("docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", "polis-jobs")
        seen = dict(line.split("=", 1) for line in env_seen.splitlines() if "=" in line)
        check("1 env", seen.get("MATH_ENV") == STAGED and seen.get("MATH_CAPACITY_ROUTING") == "0"
              and seen.get("MATH_POLLER_SOURCE_COMMIT") == args.commit,
              f"the container's env: MATH_ENV={seen.get('MATH_ENV')} (the app .env says {SMALL}), "
              f"MATH_CAPACITY_ROUTING={seen.get('MATH_CAPACITY_ROUTING')}, source commit "
              f"{(seen.get('MATH_POLLER_SOURCE_COMMIT') or '')[:12]}")
        mem = sh("docker", "inspect", "-f", "{{.HostConfig.Memory}}", "polis-jobs").strip()
        check("1 budget", int(mem) == 52 * 1024 * MB,
              f"cgroup memory limit {int(mem) // MB} MiB from POLIS_JOBS_CONTAINER_MEMORY="
              f"{proof.doc['POLIS_JOBS_CONTAINER_MEMORY']}")

        # --------------------------------------------------------------- 2
        pg, queue, job = admit("proof_ok", env_ok, zid_ok)
        st = wait_job(queue, job, lambda s: s["state"] in ("succeeded", "dead"))
        lines = child_lines("proof_ok", job)
        check("2 child", st["state"] == "succeeded",
              f"job {job[:8]} {st['state']} on the first attempt set {attempts('proof_ok', job)}")
        for needle in ("memory admission: limit_mb=53248 (cgroup)", f"staged={STAGED}",
                       f"source_commit={args.commit[:12]}", f"under label={STAGED}"):
            check("2 child", needle in lines, f"child log: {needle!r}")
        fp = pg.math_fingerprints([zid_ok], [STAGED]).get((zid_ok, STAGED))
        check("2 staged", fp is not None and fp.complete,
              f"bundle staged under {STAGED}: tick={fp.math_tick} newest_vote={fp.lvt}")
        check("2 staged", pg.math_fingerprints([zid_ok], [SMALL]).get((zid_ok, SMALL)) is None,
              f"nothing written under the served label {SMALL}")
        receipt = queue.receipt(job)
        check("2 receipt", receipt.finalized and receipt.binds(fp, STAGED),
              f"receipt: manifest names {receipt.math_env} tick={receipt.math_tick}")

        # --------------------------------------------------------------- 3
        proof.stop_unit()
        proof.install("proof_ok", env_ok, commit=None)
        proof.box_sh("systemctl start polis-jobs.service", check_rc=False)
        time.sleep(3)
        journal = proof.journal()
        running = sh("docker", "ps", "-q", "-f", "name=^polis-jobs$").strip()
        check("3 commit", "refusing: no MATH_POLLER_SOURCE_COMMIT" in journal and not running,
              "without MATH_POLLER_SOURCE_COMMIT the start script refuses; no daemon, nothing claimed")
        proof.stop_unit()

        # --------------------------------------------------------------- 4
        proof.install("proof_ok", env_ok, commit=args.commit)
        proof.box_sh("systemctl start polis-jobs.service")
        proof.wait_daemon_ready()
        zid_other = 90000 + (uuid.uuid4().int % 9000)
        conn_mod = __import__("psycopg2").connect(proof.dsn("proof_ok"))
        conn_mod.autocommit = True
        from tests.poller.test_backfill_postgres import seed_conversation
        seed_conversation(conn_mod, zid_other, participants=80, comments=30)
        conn_mod.close()
        _, queue, job = admit("proof_ok", env_ok, zid_other, staged="python-other")
        st = wait_job(queue, job, lambda s: s["attempt_count"] >= 1 and s["state"] != "running")
        lines = child_lines("proof_ok", job)
        first = attempts("proof_ok", job)[0]
        refusal = next((ln for ln in lines.splitlines() if "refused" in ln), "")
        check("4 label", not first.startswith("succeeded") and "python-other" in refusal
              and STAGED in refusal,
              f"a frame staged for python-other is refused by the child: attempt {first}; {refusal}")

        # --------------------------------------------------------------- 5
        if zid_bad is not None:
            proof.stop_unit()
            env_bad = f"wbp-{uuid.uuid4().hex[:6]}"
            proof.install("proof_mismatch", env_bad, commit=args.commit)
            proof.box_sh("systemctl start polis-jobs.service")
            proof.wait_daemon_ready()
            _, queue, job = admit("proof_mismatch", env_bad, zid_bad)
            st = wait_job(queue, job, lambda s: s["attempt_count"] >= 1 and s["state"] != "running")
            lines = child_lines("proof_mismatch", job)
            first = attempts("proof_mismatch", job)[0]
            refusal = next((ln for ln in lines.splitlines() if "cannot start" in ln), "")
            check("5 convention", not first.startswith("succeeded") and "agree = +1" in refusal
                  and "vote-convention-upgrade.md#mismatch" in refusal,
                  f"a database declaring agree=+1 is refused by the child: attempt {first}; {refusal}")
        else:
            say("5 convention", "skipped: this tree has no migration 000025 (the vote convention)")
        say("done", "every step held")
        return 0
    finally:
        proof.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
