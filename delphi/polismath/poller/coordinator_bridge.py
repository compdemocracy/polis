"""One coordinator-dispatched use of the actual poller and its math writer.

Source/restore bytes and the operation capability arrive through stdin, never
argv. This worker has only the restricted publisher credential. It neither
polls independently nor acquires/renews a lease. The database function performs
publication's final authorization; broad credentials are refused before work.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from dataclasses import dataclass

import psycopg2
from psycopg2.extras import Json

# Repository-byte pin, not an attestation of an arbitrary live database.
COORDINATOR_SQL_SHA256 = "d50f169ad7afe12d14582a6a746c622d402ecafd8131aae246812263bf2d5e82"
COORDINATOR_ENGINE_SHA256 = "b295c3e7c649b38768c4eeb69c7cb3bf59d33c0077c22c84853a44d216aa0028"
CATALOG_FINGERPRINT = "b497500ab5652f3d24775f4895736c01"
PROTOCOL = "polis-poller-bridge/1"
MAX_INPUT_BYTES = 256 * 1024 * 1024
RPC = "public.pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea)"
CONTROL_RPCS = ("public.pc_admit(text,integer,text,bigint,text,text,bigint)",
                "public.pc_reconcile(text,integer,text)", "public.pc_protect(text,integer,text,boolean)",
                "public.pc_reference(text,integer,text,text,boolean)", "public.pc_cleanup(text,integer,text)",
                "public.pc_transition(text,text,integer,text,bigint,text)")
MATH_TABLES = ("math_ticks", "math_bidtopid", "math_ptptstats", "math_main")
OWNERS = ("polis_coordinator_owner", "polis_coordinator_publication_owner")


class BridgeError(Exception):
    pass


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise BridgeError("DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    def bad_number(_):
        raise BridgeError("NONFINITE_JSON")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=bad_number)


def admit_engine(manifest_text, root=None):
    if hashlib.sha256(manifest_text.encode("utf-8")).hexdigest() != COORDINATOR_ENGINE_SHA256:
        raise BridgeError("ENGINE_MANIFEST_MISMATCH")
    manifest = strict_json(manifest_text)
    import polismath
    root = Path(root) if root is not None else Path(polismath.__file__).resolve().parent.parent
    for relative, expected in manifest["sha256"].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise BridgeError("ENGINE_SOURCE_MISMATCH")


def admit_connection(connection, namespace):
    """Check effective table AND column privileges, including inherited grants."""
    with connection.cursor() as cur:
        cur.execute("SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user")
        if any(cur.fetchone()):
            raise BridgeError("BROAD_PUBLISHER_CREDENTIAL")
        cur.execute("SELECT pg_has_role(current_user,'polis_coordinator_publisher','USAGE'),has_function_privilege(current_user,%s,'EXECUTE')", (RPC,))
        if cur.fetchone() != (True, True):
            raise BridgeError("PUBLISHER_ROLE_REQUIRED")
        for role in OWNERS + ("polis_coordinator_control",):
            cur.execute("SELECT pg_has_role(current_user,%s,'USAGE') OR pg_has_role(current_user,%s,'SET')", (role, role))
            if cur.fetchone()[0]:
                raise BridgeError("BROAD_PUBLISHER_ROLE_REACHABILITY")
        cur.execute("SELECT rolname,rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE pg_has_role(current_user,oid,'SET') OR pg_has_role(current_user,oid,'USAGE')")
        reachable=cur.fetchall()
        for role, broad in reachable:
            if broad:
                raise BridgeError("BROAD_PUBLISHER_ROLE_REACHABILITY")
            for rpc in CONTROL_RPCS:
                cur.execute("SELECT has_function_privilege(%s,%s,'EXECUTE')", (role,rpc))
                if cur.fetchone()[0]:
                    raise BridgeError("PUBLISHER_CONTROL_AUTHORITY_REFUSED")
            for table in MATH_TABLES + ("polis_coordinator_leases", "polis_coordinator_generations", "polis_coordinator_payloads",
                                       "polis_coordinator_operations", "polis_coordinator_budgets",
                                       "polis_coordinator_references", "polis_coordinator_floors",
                                       "polis_coordinator_namespaces", "polis_coordinator_principals",
                                       "polis_coordinator_transitions", "polis_coordinator_writer_authority"):
                cur.execute("""SELECT has_table_privilege(%s,%s,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
                  OR has_any_column_privilege(%s,%s,'INSERT,UPDATE')""", (role,"public." + table,role,"public." + table))
                if cur.fetchone()[0]:
                    raise BridgeError("DIRECT_PUBLISHER_DML_REFUSED")
        cur.execute("SELECT migration_id,catalog_fingerprint FROM public.polis_coordinator_install WHERE singleton")
        if cur.fetchone() != ("000021", CATALOG_FINGERPRINT):
            raise BridgeError("COORDINATOR_SCHEMA_MISMATCH")
        cur.execute("SELECT public.pc_namespace_allowed(%s)", (namespace,))
        if not cur.fetchone()[0]:
            raise BridgeError("NAMESPACE_AUTHORITY_REQUIRED")


@dataclass(frozen=True)
class Dispatch:
    namespace: str
    zid: int
    owner: str
    epoch: int
    operation: str
    capability: bytes
    expected_tick: int | None
    checkpoint: dict

    @classmethod
    def parse(cls, frame):
        if frame.get("protocol") != PROTOCOL or frame.get("schema_sha256") != COORDINATOR_SQL_SHA256:
            raise BridgeError("BRIDGE_PROTOCOL_MISMATCH")
        for key in ("zid", "epoch"):
            if type(frame.get(key)) is not int or frame[key] <= 0:
                raise BridgeError("INVALID_DISPATCH_IDENTITY")
        for key in ("namespace", "owner", "operation"):
            if not isinstance(frame.get(key), str) or not frame[key]:
                raise BridgeError("INVALID_DISPATCH_IDENTITY")
        expected = frame.get("expected_tick")
        if expected is not None and (type(expected) is not int or expected < 0):
            raise BridgeError("INVALID_EXPECTED_TICK")
        capability = bytes.fromhex(frame["capability"])
        if len(capability) != 32 or not isinstance(frame.get("checkpoint"), dict):
            raise BridgeError("INVALID_DISPATCH_CAPABILITY")
        return cls(frame["namespace"], frame["zid"], frame["owner"], frame["epoch"],
                   frame["operation"], capability, expected, frame["checkpoint"])


class Publisher:
    """The math writer's restricted publication boundary; no direct DML escape."""

    def __init__(self, url, dispatch, fault=None):
        self.url, self.dispatch, self.result = url, dispatch, None
        self.fault = fault
        self.backend_pid = None

    def stage(self, name):
        if self.fault and self.fault["stage"] == name:
            print(json.dumps({"protocol": PROTOCOL, "stage": name,
                              "backend_pid": self.backend_pid}), file=sys.__stdout__, flush=True)
            if sys.stdin.buffer.readline(32) != b"continue\n":
                raise BridgeError("FAULT_PARENT_LOST")

    def admit_test(self, connection):
        if self.dispatch.namespace in ("prod", "preprod", "dev"):
            raise BridgeError("TEST_NAMESPACE_REFUSED")
        with connection.cursor() as cur:
            cur.execute("SELECT EXISTS(SELECT 1 FROM public.p026_test_marker WHERE namespace=%s)",
                        (self.dispatch.namespace,))
            if not cur.fetchone()[0]:
                raise BridgeError("TEST_MARKER_REQUIRED")

    def authorize(self):
        d = self.dispatch
        with contextlib.closing(psycopg2.connect(self.url, connect_timeout=5)) as connection:
            with connection:
                admit_connection(connection, d.namespace)
                if self.fault:
                    self.admit_test(connection)
                with connection.cursor() as cur:
                    # Namespace admission is process-wide; writer admission is
                    # per conversation and holds the parent lock for this tx.
                    cur.execute("SELECT public.pc_assert_writer(%s,%s)", (d.namespace,d.zid))
                    cur.execute("""SELECT owner_id,owner_epoch,expires_at>clock_timestamp(),
                     dispatch_operation_id,dispatch_capability_sha256,
                     dispatch_checkpoint_sha256=encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex'),
                     dispatch_expected_tick IS NOT DISTINCT FROM %s::bigint
                     FROM public.polis_coordinator_leases WHERE math_env=%s AND zid=%s""",
                                (Json(d.checkpoint), d.expected_tick, d.namespace, d.zid))
                    row = cur.fetchone()
                    if not row or row[:2] != (d.owner, d.epoch):
                        raise BridgeError("FENCED")
                    if not row[2]:
                        raise BridgeError("LEASE-EXPIRED")
                    if row[3:] != (d.operation, hashlib.sha256(d.capability).hexdigest(), True, True):
                        raise BridgeError("DISPATCH_IDENTITY_CONFLICT")
                    cur.execute("""SELECT owner_id,owner_epoch,capability_sha256,
                      checkpoint_sha256=encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex'),
                      expected_tick IS NOT DISTINCT FROM %s::bigint,state
                      FROM public.polis_coordinator_operations WHERE math_env=%s AND zid=%s AND operation_id=%s""",
                      (Json(d.checkpoint),d.expected_tick,d.namespace,d.zid,d.operation))
                    admitted=cur.fetchone()
                    if (not admitted or admitted[:5] != (d.owner,d.epoch,hashlib.sha256(d.capability).hexdigest(),True,True)
                            or admitted[5] not in ('pending','unresolved')):
                        raise BridgeError("OPERATION_NOT_ADMITTED")

    def execute_rpc(self, connection, cur, query, args):
        """SQL latches exist only in the disposable test schema's triggers.

        Pause on an observed, blocked backend inside its real INSERT/UPDATE,
        never report a database-write stage merely for entering this method.
        """
        stages = {f"{when}_{name}" for when in ("before", "after")
                  for name in ("ticks", "bidtopid", "ptptstats", "main")}
        stage = self.fault.get("stage") if self.fault else None
        if stage not in stages:
            cur.execute(query, args)
            return
        import concurrent.futures
        import secrets
        import time
        key = secrets.randbelow(2**31-1)+1
        with contextlib.closing(psycopg2.connect(self.url, connect_timeout=5)) as monitor:
            monitor.autocommit = True
            with monitor.cursor() as observer:
                observer.execute("SELECT pg_advisory_lock(21421,%s)", (key,))
                cur.execute("SELECT set_config('p027.bridge_stage',%s,true),set_config('p027.bridge_key',%s,true)",
                            (stage,str(key)))
                try:
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                        pending = executor.submit(cur.execute, query, args)
                        deadline = time.monotonic()+120
                        try:
                            while not pending.done():
                                observer.execute("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=%s AND locktype='advisory' AND NOT granted)",
                                                 (connection.get_backend_pid(),))
                                if observer.fetchone()[0]:
                                    self.stage(stage)
                                    break
                                if time.monotonic() >= deadline:
                                    raise BridgeError("SQL_STAGE_DEADLINE")
                                time.sleep(.01)
                        finally:
                            observer.execute("SELECT pg_advisory_unlock(21421,%s)", (key,))
                        pending.result()
                finally:
                    observer.execute("SELECT pg_advisory_unlock_all()")

    def publish(self, zid, main, bidtopid, ptptstats):
        print(json.dumps({"protocol": PROTOCOL, "phase": "publication"}), file=sys.__stdout__, flush=True)
        for attempt in range(3):
            try:
                tick = self._publish_once(zid, main, bidtopid, ptptstats)
                self.result["publish_retries"] = attempt
                return tick
            except psycopg2.Error as error:
                if error.pgcode not in ("40001", "40P01") or attempt == 2:
                    raise
                time.sleep(.05 * (attempt + 1))

    def _publish_once(self, zid, main, bidtopid, ptptstats):
        d = self.dispatch
        if zid != d.zid:
            raise BridgeError("FOREIGN_PUBLICATION")
        with contextlib.closing(psycopg2.connect(self.url, connect_timeout=5)) as connection:
            with connection:
                admit_connection(connection, d.namespace)
                if self.fault:
                    self.admit_test(connection)
                with connection.cursor() as cur:
                    cur.execute("SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='5s'")
                    self.backend_pid = connection.get_backend_pid()
                    # pc_publish asserts current writer authority itself, after
                    # its exact historical readback branch. Do not pre-assert
                    # here: a withdrawn writer may still reconcile its receipt.
                    self.execute_rpc(connection, cur, "SELECT * FROM public.pc_publish(%s::text,%s::integer,%s::text,%s::bigint,%s::text,%s::bytea,%s::bigint,%s::jsonb,%s::bytea,%s::bytea,%s::bytea)",
                                (d.namespace, d.zid, d.owner, d.epoch, d.operation, d.capability,
                                 d.expected_tick, Json(d.checkpoint), main.encode("utf-8"),
                                 bidtopid.encode("utf-8"), ptptstats.encode("utf-8")))
                    row = cur.fetchone()
                    if row is None or row[0] not in ("committed", "already_committed", "conflict"):
                        raise BridgeError("MALFORMED_PUBLICATION_REPLY")
                    self.result = dict(zip(("outcome", "math_tick", "caching_tick"), row))
                    self.stage("before_commit")
                    if row[0] == "committed":
                        # The RPC still holds the lease lock. Recheck immediately
                        # before COMMIT, including after any test pause here.
                        cur.execute("""SELECT owner_id,owner_epoch,
                          expires_at-clock_timestamp()>make_interval(secs=>dispatch_margin_ms/1000.0)
                          FROM public.polis_coordinator_leases WHERE math_env=%s AND zid=%s""",
                                    (d.namespace,d.zid))
                        final = cur.fetchone()
                        if not final or final[:2] != (d.owner,d.epoch):
                            raise BridgeError("FENCED")
                        if not final[2]:
                            raise BridgeError("LEASE-EXPIRED")
            # The with-connection boundary committed before acknowledging it.
        self.stage("after_commit")
        if self.result["outcome"] == "conflict":
            raise BridgeError("PUBLICATION_CONFLICT")
        return self.result["math_tick"]


class FrozenSource:
    """The poller's full-history interface over one coordinator snapshot.

    This is not a second DB read: late arrivals remain discoverable on the next
    coordinator pass, instead of silently changing this operation's input hash.
    """

    def __init__(self, zid, source, prior, agree):
        self.zid, self.source, self.prior, self.agree = zid, source, prior, agree
        if type(agree) is not int or agree not in (-1, 1):
            raise BridgeError("INVALID_STORAGE_POLARITY")

    def load_math_main(self, zid):
        if zid != self.zid:
            raise BridgeError("FOREIGN_SOURCE")
        return self.prior

    def poll_votes(self, zid, since):
        if zid != self.zid or since is not None:
            raise BridgeError("UNDECLARED_SOURCE_READ")
        result = []
        for event in self.source["votes"]:
            if any(type(event.get(key)) is not int for key in ("pid", "tid", "vote", "created")):
                raise BridgeError("UNSUPPORTED_SOURCE_EVENT")
            if any(event[key] < 0 or event[key] > 2**63-1 for key in ("pid", "tid", "created")):
                raise BridgeError("UNSUPPORTED_SOURCE_EVENT")
            weight=event.get("weight_x_32767")
            if weight is not None and (type(weight) is not int or not -(2**63) <= weight < 2**63):
                raise BridgeError("UNSUPPORTED_SOURCE_WEIGHT")
            if event["vote"] not in (-1, 0, 1):
                raise BridgeError("UNSUPPORTED_SOURCE_VOTE")
            result.append({"pid": event["pid"], "tid": event["tid"],
                           "vote": event["vote"] * self.agree, "created": event["created"]})
        return result

    def poll_moderation(self, zid, since):
        if zid != self.zid or since is not None:
            raise BridgeError("UNDECLARED_SOURCE_READ")
        return self.source["moderation"]


def execute(frame, url):
    dispatch = Dispatch.parse(frame)
    publisher = Publisher(url, dispatch, frame.get("fault"))
    publisher.authorize()
    if "fixture_originals" in frame:
        with contextlib.closing(psycopg2.connect(url, connect_timeout=5)) as c:
            publisher.admit_test(c)
        payloads = frame["fixture_originals"]
        publisher.publish(dispatch.zid, payloads["main"], payloads["bidtopid"], payloads["ptptstats"])
        return publisher.result
    if (dispatch.checkpoint.get("engine") != "python-math-poller/1"
            or dispatch.checkpoint.get("lifecycle") != "poller-rebuild-prefix/1"
            or dispatch.checkpoint.get("seed") != 42 or dispatch.checkpoint.get("pca_mode") != "powerit"):
        raise BridgeError("UNSUPPORTED_ENGINE_PROFILE")
    if dispatch.checkpoint.get("engine_sha256") != COORDINATOR_ENGINE_SHA256:
        raise BridgeError("ENGINE_IDENTITY_MISMATCH")
    admit_engine(frame["engine_manifest"])
    schedule = {"lifecycle": "poller-rebuild-prefix/1", "seed": 42, "pca_mode": "powerit",
                "storage_agree_value": dispatch.checkpoint["storage_agree_value"]}
    schedule_hash = hashlib.sha256(json.dumps(schedule,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    if schedule_hash != dispatch.checkpoint.get("schedule_sha256"):
        raise BridgeError("SCHEDULE_IDENTITY_MISMATCH")
    import random
    import numpy as np
    random.seed(42)
    np.random.seed(42)
    os.environ["POLISMATH_PCA_IMPL"] = "powerit"
    raw = frame["input_bytes"].encode("utf-8")
    if hashlib.sha256(raw).hexdigest() != dispatch.checkpoint["input_sha256"]:
        raise BridgeError("SOURCE_BYTES_MISMATCH")
    inputs = strict_json(raw)
    source = inputs["source"]
    if (source["fingerprint"] != dispatch.checkpoint["source_fingerprint"]
            or len(source["votes"]) != dispatch.checkpoint["event_count"]):
        raise BridgeError("SOURCE_IDENTITY_MISMATCH")
    from polismath.poller.service import MathPollerService, PollerConfig
    from polismath.poller.worker_pool import CoalescedBatch

    pg = FrozenSource(dispatch.zid, source, inputs.get("prior"),
                      dispatch.checkpoint["storage_agree_value"])
    config = PollerConfig(math_env=dispatch.namespace, worker_pool_size=1, conv_cache_cap=1)
    service = MathPollerService(pg, config, publisher=publisher)
    # Actual poller rebuild/restore, compute, derive/encode, write-before-cache
    # path. Never start its independent vote/moderation/reconciliation loops.
    with contextlib.redirect_stdout(sys.stderr):
        publisher.stage("before_worker_apply")
        service._run_engine(dispatch.zid, CoalescedBatch(rebuild=True))
    if publisher.result is None:
        raise BridgeError("MISSING_PUBLICATION")
    return publisher.result


def main():
    try:
        raw = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise BridgeError("BRIDGE_INPUT_LIMIT")
        frame = strict_json(raw)
        import logging
        logging.disable(logging.CRITICAL)
        with contextlib.redirect_stdout(sys.stderr):
            result = execute(frame, os.environ["COORDINATOR_PUBLISHER_DATABASE_URL"])
        print(json.dumps({"protocol": PROTOCOL, **result}, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        # Never print DSNs, input frames, capabilities, SQL parameters or raw
        # database errors. SQLSTATE and fixed error tokens suffice for callers.
        state = getattr(error, "pgcode", None)
        token = str(error) if isinstance(error, BridgeError) else "BRIDGE_FAILED"
        if state == "P2003":
            token = "FENCED"
        elif state == "P2005":
            token = "LEASE-EXPIRED"
        elif state == "P2033" and error.diag.message_primary in (
                "WRITER_AUTHORITY_REQUIRED", "WRITER_READ_COMMITTED_REQUIRED"):
            token = error.diag.message_primary
        if token == "PUBLICATION_CONFLICT":
            print(json.dumps({"protocol": PROTOCOL, "outcome": "conflict"}), flush=True)
            return 0
        print(json.dumps({"protocol": PROTOCOL, "outcome": "error", "code": token,
                          "sqlstate": state}, separators=(",", ":")), flush=True)
        return {"FENCED": 3, "LEASE-EXPIRED": 5}.get(token, 1)


if __name__ == "__main__":
    raise SystemExit(main())
