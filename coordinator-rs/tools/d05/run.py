#!/usr/bin/env python3
"""Public full-app transition rehearsal on an owned, sealed Docker project."""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

import psycopg2
from tunnel import Tunnel

ROOT = Path(__file__).resolve().parents[3]
TABLES = ("ticks", "bidtopid", "ptptstats", "main")
FIXTURES = {1: "populated", 2: "zero", 3: "published-empty", 4: "absent", 5: "dormant", 6: "import"}


def digest(value):
    return hashlib.sha256(value).hexdigest()


class Campaign:
    def __init__(self, output, project, port):
        if not re.fullmatch(r"[a-z][a-z0-9-]{7,62}", project):
            raise ValueError("unique COMPOSE_PROJECT_NAME required")
        if not 55432 <= port <= 65000:
            raise ValueError("unique port range required")
        output.mkdir(parents=True, exist_ok=False)
        self.output, self.project, self.port = output, project, port
        self.env = dict(os.environ, COMPOSE_PROJECT_NAME=project,
                        POLIS_RECOVERY_PG_PORT=str(port), RECOVERY_PG_PORT=str(port),
                        P027_HTTP_PORT=str(port+1), P027_CONTROL_PORT=str(port+2))
        self.receipt = {"schema": "polis-d05-public/1", "project": project, "port": port,
                        "cases": [], "status": "FAIL", "scope": "coherent-content-recovery-fixtures",
                        "full_contract_gate": "FAIL", "private_science": "NOT_EVALUATED",
                        "writer_lifecycle": "poller-rebuild-prefix/1",
                        "reader_lifecycle": "fresh namespace processes; cold/warm/explicit prefetch"}
        self.config = output / "compose.json"
        self.connection = None
        self.tunnels = {}
        self.readers = {"server": ("legacy", port+1), "reader_l2": ("legacy", port+4),
                        "reader_p1": ("rustproto", port+7), "reader_p2": ("rustproto", port+10)}
        paths = [p for directory in ("coordinator-rs/src", "coordinator-rs/tools/d05", "coordinator-rs/schemas",
                                      "delphi/polismath", "server/src", "server/characterization", "server/postgres/migrations")
                 for p in (ROOT/directory).rglob("*") if p.is_file() and p.suffix in (".rs", ".py", ".ts", ".sql", ".json", ".cjs")
                 and "artifacts" not in p.parts and "__pycache__" not in p.parts]
        paths += [ROOT/name for name in ("server/app.ts", "server/index.ts", "server/package-lock.json", "coordinator-rs/Cargo.lock")]
        self.receipt["source_sha256"] = {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in sorted(paths)}
        self.receipt["binary_sha256"] = digest((ROOT/"coordinator-rs/target/fault/debug/polis-coordinator").read_bytes())
        attribution = ROOT.parent/"source-reconciliation.json"
        if not attribution.is_file():
            raise ValueError("run from an attributed source_workspace snapshot")
        source_report = json.loads(attribution.read_text())
        self.receipt["source_head"] = source_report["source_head"]
        (output/"source-reconciliation.json").write_bytes(attribution.read_bytes())

    def command(self, argv, *, check=True):
        result = subprocess.run(argv, cwd=ROOT, env=self.env, text=True, capture_output=True)
        with (self.output / "commands.log").open("a") as stream:
            stream.write(json.dumps(argv)+"\n"+result.stdout+result.stderr)
        if check and result.returncode:
            raise RuntimeError(f"command failed ({result.returncode}): {argv[:4]}")
        return result.stdout

    def dc(self, *args, check=True):
        return self.command(["docker", "compose", "-f", str(self.config), *args], check=check)

    def check(self, name, condition, **evidence):
        if any(c["name"] == name for c in self.receipt["cases"]):
            raise AssertionError(f"duplicate case: {name}")
        self.receipt["cases"].append(dict(name=name, passed=bool(condition), **evidence))
        self.save()
        if not condition:
            raise AssertionError(name)

    def save(self):
        (self.output / "receipt.json").write_text(json.dumps(self.receipt, indent=2)+"\n")

    def query(self, sql, args=()):
        with self.connection.cursor() as cur:
            cur.execute(sql, args or None)
            return cur.fetchall() if cur.description else []

    def http(self, reader, path, *, control=0, headers=None, method="GET", body=None):
        port = self.readers[reader][1] + control
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                         headers=headers or {}, data=body)
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        raw = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return response.status, dict(response.headers), raw

    def ready(self, reader):
        deadline = time.monotonic()+90
        while time.monotonic() < deadline:
            try:
                status, _, raw = self.http(reader, "/ready", control=1)
                if status == 200 and json.loads(raw)["ready"]:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(.2)
        raise RuntimeError(f"app not ready: {reader}")

    def prepare(self):
        raw = self.command(["docker", "compose", "-f", str(ROOT/"server/characterization/compose.yml"),
                            "config", "--format", "json"])
        config = json.loads(raw)
        config["name"] = self.project
        base = config["services"]["server"]
        config["services"].pop("driver")
        config["services"].pop("math-seed", None)
        config["services"]["postgres"]["image"] = "postgres:17-alpine"
        config["services"]["postgres"].pop("ports", None)
        for name, (namespace, port) in self.readers.items():
            service = copy.deepcopy(base)
            service["command"] = ["node", "/app/d05-entry.cjs"]
            service["environment"].update(MATH_ENV=namespace, P026_READER_ID=name)
            service.pop("ports", None)
            for mount in service["volumes"]:
                if mount["target"] == "/artifacts":
                    mount["source"] = str(self.output)
            service["volumes"].append({"type": "bind", "source": str(ROOT/"coordinator-rs/tools/d05/entry.cjs"),
                                       "target": "/app/d05-entry.cjs", "read_only": True})
            config["services"][name] = service
        images = {}
        for service in config["services"].values():
            tag = service["image"]
            if tag not in images:
                images[tag] = self.command(["docker", "image", "inspect", tag, "--format", "{{.Id}}"]).strip()
            service["image"] = images[tag]
        self.receipt["images"] = images
        self.config.write_text(json.dumps(config, indent=2)+"\n")
        self.dc("up", "-d", "--wait", "postgres", "dynamodb", "file-server", "oidc-simulator")
        self.tunnels["postgres"] = [Tunnel(self.port, ["docker", "exec", "-i", self.dc("ps", "-q", "postgres").strip(),
                                                       "nc", "127.0.0.1", "5432"])]
        self.connection = psycopg2.connect(f"postgresql://postgres@127.0.0.1:{self.port}/p027")
        self.connection.autocommit = True
        for path in sorted((ROOT/"server/postgres/migrations").glob("*.sql")):
            self.query(path.read_text())
        self.query("CREATE ROLE d05_control LOGIN; CREATE ROLE d05_publisher LOGIN; CREATE ROLE d05_operator_p LOGIN; CREATE ROLE d05_operator_l LOGIN")
        self.query("GRANT polis_coordinator_control TO d05_control,d05_operator_p,d05_operator_l; GRANT polis_coordinator_publisher TO d05_publisher")
        self.query("GRANT USAGE ON SCHEMA public TO d05_control,d05_publisher,d05_operator_p,d05_operator_l")
        self.query("GRANT SELECT ON conversations,participants,comments,votes,math_ticks,math_main,math_bidtopid,math_ptptstats TO d05_control")
        self.query("GRANT UPDATE(topic) ON conversations TO d05_control")
        self.query("INSERT INTO polis_coordinator_namespaces VALUES('legacy','legacy',64),('rustproto','python',64)")
        for role, namespace, operator in (("d05_control", "rustproto", False), ("d05_publisher", "rustproto", False),
                                           ("d05_operator_p", "rustproto", True), ("d05_operator_l", "legacy", True)):
            self.query("INSERT INTO polis_coordinator_principals SELECT oid,rolname,%s,%s FROM pg_roles WHERE rolname=%s", (namespace, operator, role))
        self.query("INSERT INTO polis_coordinator_budgets VALUES('rustproto',128,8589934592)")
        self.query("INSERT INTO users(uid,hname,email,is_owner,site_id) VALUES(1,'Owner','owner@example.invalid',true,'d05-owner'),(2,'Admin','admin@example.invalid',true,'d05-admin')")
        for zid, shape in FIXTURES.items():
            self.query("INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public,profanity_filter,spam_filter) VALUES(%s,1,%s,true,false,true,false,false)", (zid, "Generated "+shape))
            self.query("INSERT INTO zinvites(zid,zinvite) VALUES(%s,%s)", (zid, self.capability(zid)))
            self.query("INSERT INTO reports(zid,report_id) VALUES(%s,%s)", (zid, self.report(zid)))
            if zid == 3:
                continue
            for pid in range(6):
                uid = zid*100+pid
                self.query("INSERT INTO users(uid,hname,email,site_id) VALUES(%s,%s,%s,%s)", (uid, f"Generated {uid}", f"u{uid}@example.invalid", f"d05-{uid}"))
                self.query("INSERT INTO participants(zid,pid,uid) VALUES(%s,%s,%s)", (zid,pid,uid))
            for tid in range(4):
                self.query("INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified) VALUES(%s,%s,0,%s,%s,0,false,1000,1000)", (zid,tid,zid*100,f"Generated statement {tid}"))
                for pid in range(6):
                    self.query("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(%s,%s,%s,%s,%s)", (zid,pid,tid,[-1,1,0][(pid+tid)%3],1000+pid*4+tid))
        self.receipt["migrations"] = {p.name: digest(p.read_bytes()) for p in sorted((ROOT/"server/postgres/migrations").glob("*.sql"))}
        self.receipt["schema_seal"] = self.query("SELECT catalog_fingerprint FROM polis_coordinator_install")[0][0]

    @staticmethod
    def capability(zid):
        return f"2d05generated{zid}"

    @staticmethod
    def report(zid):
        return f"r2d05generated{zid}"

    def publish(self, name, zids=tuple(FIXTURES)):
        env = dict(self.env, DATABASE_URL=f"postgresql://d05_control@127.0.0.1:{self.port}/p027",
                   COORDINATOR_PUBLISHER_DATABASE_URL=f"postgresql://d05_publisher@127.0.0.1:{self.port}/p027",
                   MATH_ENV="rustproto", P026_PYTHON=sys.executable, PYTHONPATH=str(ROOT/"delphi"),
                   PYTHONDONTWRITEBYTECODE="1", OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1",
                   P026_RESERVATION_BYTES="67108864", POLL_ALLOWLIST=",".join(map(str,zids)),
                   P026_ENVIRONMENT="generated", P026_LEASE_SECONDS="120")
        result = subprocess.run([str(ROOT/"coordinator-rs/target/fault/debug/polis-coordinator"), "once"],
                                cwd=ROOT/"delphi", env=env, capture_output=True, text=True, timeout=180)
        (self.output/f"{name}.log").write_text(result.stdout+result.stderr)
        self.check(name, result.returncode == 0, exit_code=result.returncode)

    def snapshot(self, zid, tick):
        # A coherent legacy content-recovery fixture. This is not a Clojure
        # recomputation or a science-equivalence assertion.
        for table in TABLES:
            columns = [r[0] for r in self.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position", ("math_"+table,))]
            selected = ["'legacy'" if c == "math_env" else str(tick) if c == "math_tick" else
                        "NULL" if c in ("publisher_epoch", "input_checkpoint", "operation_id") else c for c in columns]
            self.query(f"INSERT INTO math_{table}({','.join(columns)}) SELECT {','.join(selected)} FROM math_{table} WHERE zid=%s AND math_env='rustproto'", (zid,))

    def transition(self, source, destination, zid, last, label):
        role = "d05_operator_p" if destination == "rustproto" else "d05_operator_l"
        with psycopg2.connect(f"postgresql://{role}@127.0.0.1:{self.port}/p027") as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM pc_transition(%s,%s,%s,%s,%s,%s)",
                            (source,destination,zid,label,last,digest(f"{label}:no-live-legacy-process".encode())))
                row = cur.fetchone()
        self.check(f"{label}/floor", row[1] >= last, outcome=row[0], floor=row[1], tick=row[2], cursor=row[3])
        return row

    def start(self, *readers):
        self.dc("up", "-d", *readers)
        for reader in readers:
            for tunnel in self.tunnels.pop(reader, []):
                tunnel.close()
            container = self.dc("ps", "-q", reader).strip()
            script = "const s=require('net').connect(Number(process.argv[1]),'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));"
            self.tunnels[reader] = [Tunnel(self.readers[reader][1]+i, ["docker", "exec", "-i", container, "node", "-e", script, str(target)])
                                    for i,target in enumerate((5000,5001,5002))]
            self.ready(reader)
        ids = self.dc("ps", "-q").split()
        containers = json.loads(self.command(["docker", "inspect", *ids]))
        networks = {n["NetworkID"] for item in containers for n in item["NetworkSettings"]["Networks"].values()}
        inspected = json.loads(self.command(["docker", "network", "inspect", *networks]))
        if (len(inspected) != 1 or not inspected[0]["Internal"] or
                inspected[0]["Labels"].get("com.docker.compose.project") != self.project or
                any(item["HostConfig"]["Privileged"] or item["HostConfig"].get("CapAdd") for item in containers)):
            raise RuntimeError("sealed topology identity failed")
        self.receipt.setdefault("topology", []).append({"internal_network": next(iter(networks)),
            "containers": {item["Config"]["Labels"]["com.docker.compose.service"]:
                           {"id": item["Id"], "image": item["Image"]} for item in containers}})

    def close(self):
        if self.connection:
            self.connection.close()
        for tunnels in self.tunnels.values():
            for tunnel in tunnels:
                tunnel.close()
        if self.config.exists():
            self.dc("logs", "--no-color", check=False)
            self.dc("down", "--volumes", "--remove-orphans", check=False)
        resources = {}
        for kind in ("container", "network", "volume"):
            resources[kind] = self.command(["docker", kind, "ls", "-q", "--filter", f"label=com.docker.compose.project={self.project}"]).split()
        self.receipt["remaining_resources"] = resources
        if any(resources.values()):
            self.receipt["status"] = "FAIL"
        self.receipt["artifact_sha256"] = {str(p.relative_to(self.output)): digest(p.read_bytes())
            for p in sorted(self.output.rglob("*")) if p.is_file() and p.name != "receipt.json"}
        self.save()
        if any(resources.values()):
            raise RuntimeError("owned resource cleanup incomplete")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    campaign = Campaign(args.output.resolve(), os.environ["COMPOSE_PROJECT_NAME"], int(os.environ["POLIS_RECOVERY_PG_PORT"]))
    try:
        campaign.prepare()
        campaign.publish("initial-python-publication")
        for zid in FIXTURES:
            if zid != 4:
                campaign.snapshot(zid, 0 if zid in (2,3) else 41)
        campaign.start("server", "reader_l2")
        # The transfer cases are a separate module so exact case inventory and
        # assertions can be reviewed independently of stack provisioning.
        from cases import exercise
        exercise(campaign)
        inventory = json.loads((ROOT/"coordinator-rs/tools/d05/inventory.json").read_text())
        if [item["name"] for item in campaign.receipt["cases"]] != inventory["cases"]:
            raise AssertionError("exact D05 case inventory mismatch")
        for name, expected in campaign.receipt["source_sha256"].items():
            if digest((ROOT/name).read_bytes()) != expected:
                raise AssertionError("source changed: "+name)
        campaign.receipt["status"] = "PASS"
    except BaseException as error:
        campaign.receipt["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        campaign.close()


if __name__ == "__main__":
    main()
