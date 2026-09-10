#!/usr/bin/env python3
"""D07 groundwork: public input/image census and real rev6 rollback controls.

This deliberately stops at independent observation. It does not run a writer,
serve HTTP, amend the migration, or turn a boundary receipt into admission.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys

import psycopg2

ROOT = Path(__file__).resolve().parents[3]
SQL = "server/postgres/migrations/000021_create_polis_coordinator.sql"
SQL_SHA256 = "a3a85e24e69e281adbe04831b9e02525c292a1960461cae12d048f7c2d9e89a8"
IMAGES = ("postgres:17-alpine", "p027-server", "p027-file-server",
          "p027-oidc-simulator", "amazon/dynamodb-local:latest",
          "p011-delphi-test:latest", "p024s-8fq2-math:latest")
CASES = (
    "sealed-rev6-schema", "active-python-dispatch", "ordinary-transition-denied",
    "missing-fallback-denied", "legacy-reticked-above-python", "four-ticks-coherent",
    "payload-bytes-preserved", "python-dispatch-withdrawn", "stale-admission-denied",
    "withdrawal-does-not-resolve-pending", "absent-receipt-stays-unresolved",
    "restart-can-reacquire-after-transition", "cross-namespace-lease-denied",
    "observer-is-not-a-writer", "observer-metadata-denied", "writer-is-not-observer",
    "schema-seal-unchanged",
)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def public_census():
    """Only tracked public CSVs, never environment maps or .local fallback."""
    result = {}
    for slug, count in (("vw", 4683), ("biodiversity", 29802)):
        matches = sorted((ROOT / "delphi/real_data").glob("*-" + slug))
        if len(matches) != 1 or matches[0].is_symlink():
            raise ValueError("one public directory required: " + slug)
        paths = sorted(matches[0].glob("*-votes.csv"))
        if len(paths) != 1 or paths[0].is_symlink():
            raise ValueError("one public votes CSV required: " + slug)
        path = paths[0]
        subprocess.run(["git", "ls-files", "--error-unmatch", "--", str(path.relative_to(ROOT))],
                       cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        raw = path.read_bytes()
        rows = list(csv.DictReader(raw.decode().splitlines()))
        if len(rows) != count:
            raise ValueError("public input census changed: " + slug)
        cells = {(int(r["voter-id"]), int(r["comment-id"])) for r in rows}
        if any(int(r["vote"]) not in (-1, 0, 1) for r in rows):
            raise ValueError("invalid public vote")
        result[slug] = {"sha256": sha(raw), "bytes": len(raw), "vote_events": len(rows),
                        "participants": len({p for p, _ in cells}),
                        "voted_comments": len({t for _, t in cells}), "distinct_cells": len(cells),
                        "cuts": [len(rows)//4, len(rows)//2, len(rows)],
                        "timestamp_resolution": "seconds expanded to milliseconds",
                        "storage_vote": "negative of export sign",
                        "execution": "NOT_RUN"}
    return result


class Boundary:
    def __init__(self, output, project, port):
        if not re.fullmatch(r"[a-z][a-z0-9-]{7,62}", project) or not 55432 <= port <= 65000:
            raise ValueError("unique project and test port required")
        if output.is_relative_to(ROOT):
            raise ValueError("output must be outside the checkout")
        output.mkdir(parents=True, exist_ok=False)
        self.output, self.project, self.port = output, project, port
        self.connections = []
        self.started = False
        self.env = dict(os.environ, COMPOSE_PROJECT_NAME=project,
                        POLIS_RECOVERY_PG_PORT=str(port), RECOVERY_PG_PORT=str(port))
        self.config = output / "compose.json"
        self.receipt = {"schema": "polis-d07-boundary/1", "status": "FAIL",
                        "full_contract_gate": "FAIL", "project": project, "port": port,
                        "checks": [], "blocker": "D06_READ_ONLY_OBSERVER_AUTHORITY",
                        "scope": "rev6 SQL boundary; no writer or HTTP execution",
                        "rehearsal": "NOT_RUN", "capacity": "NOT_MEASURED",
                        "source_sha256": {}}

    def command(self, args, check=True):
        r = subprocess.run(args, cwd=ROOT, env=self.env, text=True, capture_output=True,
                           timeout=120, check=False)
        with (self.output / "commands.log").open("a") as f:
            f.write(json.dumps(args) + "\n" + r.stdout + r.stderr)
        if check and r.returncode:
            raise RuntimeError("command failed: " + args[0])
        return r.stdout

    def resources(self):
        return {kind: self.command(["docker", kind, "ls", "-q", "--filter",
                                    "label=com.docker.compose.project=" + self.project]).split()
                for kind in ("container", "network", "volume")}

    def check(self, name, passed, **evidence):
        expected = CASES[len(self.receipt["checks"])]
        if name != expected:
            raise AssertionError("case inventory: " + name)
        self.receipt["checks"].append(dict(name=name, passed=bool(passed), **evidence))
        self.save()
        if not passed:
            raise AssertionError(name)

    def save(self):
        (self.output / "receipt.json").write_text(json.dumps(self.receipt, indent=2) + "\n")

    def connect(self, role="postgres"):
        c = psycopg2.connect(host="127.0.0.1", port=self.port, user=role, dbname="p026",
                             connect_timeout=5, options="-c statement_timeout=5000 -c lock_timeout=1000")
        c.autocommit = True
        self.connections.append(c)
        return c

    @staticmethod
    def query(conn, sql, args=None):
        with conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall() if cur.description else []

    def denied(self, name, conn, sql, args, state):
        actual = None
        try:
            self.query(conn, sql, args)
        except psycopg2.Error as error:
            actual = error.pgcode
        self.check(name, actual == state, expected_sqlstate=state, sqlstate=actual)

    def run(self):
        if any(self.resources().values()):
            raise ValueError("project already owns resources; refusing reuse")
        with socket.socket() as s:
            s.bind(("127.0.0.1", self.port))
        self.receipt["source_head"] = self.command(["git", "rev-parse", "HEAD"]).strip()
        for path in sorted(Path(__file__).parent.glob("*")):
            if path.is_file():
                self.receipt["source_sha256"][str(path.relative_to(ROOT))] = sha(path.read_bytes())
        for name in (SQL, "coordinator-rs/src/store.rs", "coordinator-rs/src/lease.rs",
                     "coordinator-rs/tools/d05/cases.py", "coordinator-rs/tools/d05/run.py",
                     "math/src/polismath/components/postgres.clj"):
            self.receipt["source_sha256"][name] = sha((ROOT/name).read_bytes())
        if self.receipt["source_sha256"][SQL] != SQL_SHA256:
            raise ValueError("requires reviewed rev6 schema")
        self.receipt["public_inputs"] = public_census()
        images = {}
        for tag in IMAGES:
            image = json.loads(self.command(["docker", "image", "inspect", tag,
                "--format", '{{json .Id}}']))
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
                raise ValueError("uncached image: " + tag)
            images[tag] = {"id": image, "platform": self.command(["docker", "image", "inspect", image,
                                            "--format", "{{.Os}}/{{.Architecture}}"]).strip(),
                           "execution": "DB_ONLY" if tag == IMAGES[0] else "NOT_RUN"}
        self.receipt["images"] = images
        config = {"name": self.project, "services": {"postgres": {
            "image": images[IMAGES[0]]["id"], "pull_policy": "never",
            "environment": {"POSTGRES_USER": "postgres", "POSTGRES_DB": "p026",
                            "POSTGRES_HOST_AUTH_METHOD": "trust"},
            "ports": [f"127.0.0.1:{self.port}:5432"],
            "tmpfs": ["/var/lib/postgresql/data"],
            "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U postgres -d p026"],
                            "interval": "1s", "timeout": "3s", "retries": 40}}}}
        self.config.write_text(json.dumps(config, indent=2) + "\n")
        self.started = True
        self.command(["docker", "compose", "-f", str(self.config), "up", "-d", "--wait", "--pull", "never"])
        admin = self.connect()
        q = lambda sql, args=None: self.query(admin, sql, args)
        migrations = sorted((ROOT / "server/postgres/migrations").glob("*.sql"))
        self.receipt["migrations"] = {p.name: sha(p.read_bytes()) for p in migrations}
        for path in migrations:
            q(path.read_text())
        catalog = q("SELECT pg_temp.pc_catalog()")[0][0]
        q("SELECT pg_temp.pc_assert_provenance()")
        self.receipt["postgres"] = q("SELECT version()")[0][0]
        self.receipt["catalog"] = catalog
        self.check("sealed-rev6-schema", len(migrations) == 21)
        q("CREATE ROLE d07_control LOGIN; CREATE ROLE d07_publisher LOGIN; CREATE ROLE d07_operator LOGIN; CREATE ROLE d07_observer LOGIN")
        q("GRANT polis_coordinator_control TO d07_control,d07_operator; GRANT polis_coordinator_publisher TO d07_publisher")
        q("INSERT INTO polis_coordinator_namespaces VALUES('public_python','python',8),('public_legacy','legacy',8)")
        for role, ns, operator in (("d07_control", "public_python", False),
                                  ("d07_publisher", "public_python", False),
                                  ("d07_operator", "public_legacy", True),
                                  ("d07_observer", "public_python", False)):
            q("INSERT INTO polis_coordinator_principals SELECT oid,rolname,%s,%s FROM pg_roles WHERE rolname=%s", (ns,operator,role))
        q("INSERT INTO polis_coordinator_budgets VALUES('public_python',8,10485760)")
        q("INSERT INTO conversations(zid,topic) VALUES(1,'Public rollback metadata control'),(2,'Absent fallback control')")
        # These deliberately tiny payloads exercise only the SQL transition
        # contract. They are never fed to readers or described as science.
        for ns, tick in (("public_python",80),("public_legacy",41)):
            q("INSERT INTO math_ticks(zid,math_env,math_tick) VALUES(1,%s,%s)", (ns,tick))
            for table in ("main","bidtopid","ptptstats"):
                columns = ",last_vote_timestamp" if table == "main" else ""
                values = ",1000" if table == "main" else ""
                q(f"INSERT INTO math_{table}(zid,math_env,math_tick,data{columns}) VALUES(1,%s,%s,'{{}}'{values})", (ns,tick))
        control, publisher, operator, observer = (self.connect("d07_"+r) for r in ("control","publisher","operator","observer"))
        cq = lambda sql,args=None: self.query(control,sql,args)
        cq("INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at,dispatch_operation_id,dispatch_capability_sha256,dispatch_checkpoint_sha256,dispatch_expected_tick,dispatch_margin_ms) VALUES('public_python',1,'public-old',1,clock_timestamp()+interval '5 minutes','public-pending',repeat('a',64),repeat('b',64),80,500)")
        admitted = cq("SELECT pc_admit('public_python',1,'public-old',1,'public-pending',repeat('c',64),1048576)")
        self.check("active-python-dispatch", admitted == [("admitted",)])
        transition = "SELECT * FROM pc_transition('public_python','public_legacy',%s,%s,80,%s)"
        args = (1,"public-rollback",sha(b"SQL-only fixture; no legacy process launched"))
        self.denied("ordinary-transition-denied",control,transition,args,"P2030")
        self.denied("missing-fallback-denied",operator,transition,(2,"absent",args[2]),"P2031")
        before = [q(f"SELECT data::text FROM math_{t} WHERE math_env='public_legacy' AND zid=1")[0][0]
                  for t in ("main","bidtopid","ptptstats")]
        result = self.query(operator,transition,args)[0]
        self.receipt["transition"] = list(result)
        self.check("legacy-reticked-above-python", result[0] == "legacy_reticked" and result[1] == 80 and result[2] == 81)
        ticks = [q(f"SELECT math_tick FROM math_{t} WHERE math_env='public_legacy' AND zid=1")[0][0]
                 for t in ("ticks","main","bidtopid","ptptstats")]
        self.check("four-ticks-coherent", ticks == [81]*4, ticks=ticks)
        after = [q(f"SELECT data::text FROM math_{t} WHERE math_env='public_legacy' AND zid=1")[0][0]
                 for t in ("main","bidtopid","ptptstats")]
        self.check("payload-bytes-preserved", before == after)
        revoked = cq("SELECT expires_at<=clock_timestamp(),dispatch_operation_id,dispatch_capability_sha256,dispatch_checkpoint_sha256,dispatch_expected_tick,dispatch_margin_ms FROM polis_coordinator_leases WHERE zid=1")
        self.check("python-dispatch-withdrawn", revoked == [(True,None,None,None,None,None)])
        self.denied("stale-admission-denied",control,"SELECT pc_admit('public_python',1,'public-old',1,'public-pending',repeat('c',64),1048576)",None,"P2020")
        pending = cq("SELECT state FROM polis_coordinator_operations WHERE zid=1")
        self.check("withdrawal-does-not-resolve-pending", pending == [("pending",)])
        outcome = cq("SELECT pc_reconcile('public_python',1,'public-pending')")
        self.check("absent-receipt-stays-unresolved", outcome == [("unresolved",)])
        # Use the exact acquire statement from the actual coordinator, changing
        # only driver placeholders. A new process, not renewal of a dead lease.
        source = (ROOT / "coordinator-rs/src/store.rs").read_text()
        acquire = re.findall(r'tx\.query\("(INSERT INTO polis_coordinator_leases .*?)", &\[', source)
        if len(acquire) != 1:
            raise ValueError("exact production acquire statement unavailable")
        arguments = ("public_python",1,"public-restarted",120)
        indexes = [int(i)-1 for i in re.findall(r'\$(\d+)', acquire[0])]
        statement = re.sub(r'\$\d+', '%s', acquire[0])
        restarted = cq(statement, tuple(arguments[i] for i in indexes))
        self.check("restart-can-reacquire-after-transition", restarted == [(2,)], epoch=restarted[0][0])
        self.denied("cross-namespace-lease-denied",control,
                    "INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('public_legacy',1,'bad',1,clock_timestamp())",None,"42501")
        authority = self.query(observer,"SELECT rolsuper,rolbypassrls,rolcreaterole,pg_has_role(session_user,'polis_coordinator_control','MEMBER'),pg_has_role(session_user,'polis_coordinator_publisher','MEMBER') FROM pg_roles WHERE rolname=session_user")
        self.check("observer-is-not-a-writer", authority == [(False,False,False,False,False)])
        self.denied("observer-metadata-denied",observer,"SELECT state,admitted_at FROM polis_coordinator_operations",None,"42501")
        privileged = self.query(publisher,"SELECT has_function_privilege(session_user,'pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea)','EXECUTE'),count(*) FROM polis_coordinator_operations")
        self.check("writer-is-not-observer", privileged == [(True,1)])
        q("SELECT pg_temp.pc_assert_provenance()")
        self.check("schema-seal-unchanged", q("SELECT pg_temp.pc_catalog()") == [(catalog,)])
        self.receipt["status"] = "BLOCKED"

    def close(self):
        for conn in self.connections:
            conn.close()
        if self.started:
            self.command(["docker", "compose", "-f", str(self.config), "down", "--volumes", "--remove-orphans"])
        self.receipt["remaining_resources"] = self.resources()
        if any(self.receipt["remaining_resources"].values()):
            self.receipt["status"] = "FAIL"
        self.receipt["artifact_sha256"] = {p.name: sha(p.read_bytes()) for p in sorted(self.output.iterdir())
                                            if p.is_file() and p.name != "receipt.json"}
        self.save()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    project = os.environ["COMPOSE_PROJECT_NAME"]
    port = int(os.environ["POLIS_RECOVERY_PG_PORT"])
    if str(port) != os.environ["RECOVERY_PG_PORT"]:
        p.error("test ports must agree")
    run = Boundary(args.output.resolve(),project,port)
    try:
        run.run()
    except BaseException as error:
        run.receipt["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        run.close()
    print(json.dumps({"status": run.receipt["status"], "checks":len(run.receipt["checks"]),
                      "blocker":run.receipt["blocker"], "rehearsal":"NOT_RUN"}))
    return 2  # Boundary reproduction is never a D07 acceptance exit.


if __name__ == "__main__":
    sys.exit(main())
