"""polis-engine/1 stdio worker, P-026 candidate profile (no persistence).

The coordinator freezes files before dispatch; the worker admits them once.
Control stdout is JSONL only. Numerical routines and writer derivation are reused.
The local manifest/schedule schema is documented in coordinator-rs/README.md.
"""
import argparse
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import random
import sys

PROTOCOL = "polis-engine/1"
CANDIDATE_SCHEMA = "polis-candidate-input/1"
ENGINE_VERSION = "python-conversation/p026-s1"
LIMIT = 65536
BULK_LIMIT = 256 * 1024 * 1024


class ProtocolError(Exception):
    def __init__(self, code):
        self.code = code


def fail(code="INVALID_INPUT"):
    raise ProtocolError(code)


def strict_json(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                fail()
            out[key] = value
        return out
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: fail())
    except (ValueError, UnicodeError):
        fail()


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 2**63 - 1:
        fail()
    return value


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def descriptor(root, path):
    raw = (root / path).read_bytes()
    return {"path": path, "bytes": len(raw), "sha256": sha(raw)}


def admitted(root, desc):
    if not isinstance(desc, dict) or set(desc) != {"path", "bytes", "sha256"}:
        fail()
    if not isinstance(desc["path"], str) or not isinstance(desc["sha256"], str):
        fail()
    relative = Path(desc["path"])
    if relative.is_absolute() or ".." in relative.parts:
        fail()
    path = root
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            fail()
    if not path.is_file() or root.resolve() not in path.resolve().parents:
        fail()
    size = integer(desc["bytes"])
    if size > BULK_LIMIT or path.stat().st_size != size:
        fail("RESOURCE_LIMIT")
    raw = path.read_bytes()
    if sha(raw) != desc["sha256"]:
        fail("CHECKSUM_MISMATCH")
    return raw


def emit_payloads(conv, zid, empty_contract=True):
    from polismath.poller.math_writer import derive_bidtopid, derive_ptptstats
    from polismath.utils.serialization import convert_numpy_types
    main = conv.to_dict()
    bid = derive_bidtopid(conv, zid)
    stats = derive_ptptstats(conv, zid, main.get("user-vote-counts", {}))
    if empty_contract and conv.raw_rating_mat.empty:
        # Serialization-only correction; the engine's internal seed is unchanged.
        main.update({"zid": zid, "n": 0, "n-cmts": 0, "tids": [], "in-conv": [],
            "base-clusters": {k: [] for k in ("id", "members", "x", "y", "count")},
            "group-clusters": [], "group-votes": {}, "votes-base": {},
            "user-vote-counts": {}, "comment-priorities": {},
            "consensus": {"agree": [], "disagree": []}, "group-aware-consensus": {},
            "repness": {}, "meta-tids": sorted(conv.meta_tids),
            "mod-in": sorted(conv.mod_in_tids), "mod-out": sorted(conv.mod_out_tids),
            "lastVoteTimestamp": 0, "lastModTimestamp": conv.last_mod_timestamp,
            "pca": {"center": [], "comps": [[], []],
                    "comment-projection": [[], []], "comment-extremity": []}})
        bid = {"zid": zid, "bidToPid": [], "lastVoteTimestamp": 0}
        stats = {"zid": zid, "ptptstats": {}, "lastVoteTimestamp": 0}
    return strict_json(json.dumps({"main": main, "bidtopid": bid, "ptptstats": stats},
                                  default=convert_numpy_types, allow_nan=False))


class Adapter:
    def __init__(self, input_root, output_root):
        self.input_root = Path(input_root).resolve()
        self.output_root = Path(output_root).resolve()
        self.output_root.mkdir(parents=True, exist_ok=True)
        self.state = "NEW"
        self.identity = None
        self.request_id = 0
        self.vote_cursor = self.mod_cursor = 0
        self.math_cursors = None
        self.compute_id = None
        self.operation = 0

    def cursors(self):
        return {"votes": {"slot": self.vote_cursor,
                           "sha256": sha(b"".join(self.vote_lines[:self.vote_cursor]))},
                "moderation": {"slot": self.mod_cursor,
                                "sha256": sha(b"".join(self.mod_lines[:self.mod_cursor]))}}

    def handle(self, req):
        if set(req) != {"protocol", "run_id", "session_id", "request_id", "op", "payload"}:
            fail()
        if req["protocol"] != PROTOCOL:
            fail("UNSUPPORTED_VERSION")
        ident = (req["run_id"], req["session_id"])
        if not all(isinstance(x, str) and 0 < len(x) <= 128 for x in ident):
            fail()
        rid = integer(req["request_id"], 1)
        if rid <= self.request_id or (self.identity is not None and ident != self.identity):
            fail("INVALID_SEQUENCE")
        self.identity, self.request_id = ident, rid
        op, p = req["op"], req["payload"]
        if not isinstance(p, dict):
            fail()
        if op == "initialize":
            if self.state != "NEW":
                fail("INVALID_SEQUENCE")
            result = self.initialize(p)
            self.state = "READY"
            return result
        if self.state != "READY":
            fail("INVALID_SEQUENCE")
        if self.operation >= len(self.schedule) or self.schedule[self.operation] != {"op": op, "payload": p}:
            fail("INVALID_SEQUENCE")
        self.operation += 1
        if op == "apply_votes":
            self.apply_votes(p)
            return {"observed_state_cursors": self.cursors()}
        if op == "apply_moderation":
            self.apply_mods(p)
            return {"observed_state_cursors": self.cursors()}
        if op == "compute":
            if set(p) != {"compute_id", "logical_clock"}:
                fail()
            integer(p["logical_clock"])
            self.conv = self.conv.recompute()
            self.compute_id = p["compute_id"]
            self.math_cursors = self.cursors()
            return {"compute_id": self.compute_id, "state_generation": rid,
                    "math_input_cursors": self.math_cursors}
        if op == "snapshot":
            return self.snapshot(p)
        if op == "restore":
            return self.restore(p)
        if op == "close":
            if p:
                fail()
            self.state = "CLOSED"
            return {"closed": True}
        fail("UNSUPPORTED_VERSION")

    def initialize(self, p):
        from polismath.conversation.conversation import Conversation
        import numpy as np
        if set(p) != {"input_manifest", "resolved_schedule", "config", "required_capabilities", "admission"}:
            fail()
        if set(p["required_capabilities"]) - {"rebuild-prefix/1", "snapshot-moderation/1"}:
            fail("UNSUPPORTED_VERSION")
        admission = p["admission"]
        keys = {"candidate_schema", "engine_version", "input_digest", "schedule_digest", "operation_id"}
        if not isinstance(admission, dict) or set(admission) != keys or any(
                not isinstance(v, str) or not 0 < len(v) <= 128 for v in admission.values()):
            fail("MALFORMED_CANDIDATE")
        if admission["candidate_schema"] != CANDIDATE_SCHEMA:
            fail("CANDIDATE_SCHEMA_MISMATCH")
        if admission["engine_version"] != ENGINE_VERSION:
            fail("ENGINE_VERSION_MISMATCH")
        manifest_raw = admitted(self.input_root, p["input_manifest"])
        if admission["input_digest"] != sha(manifest_raw):
            fail("INPUT_DIGEST_MISMATCH")
        schedule_raw = admitted(self.input_root, p["resolved_schedule"])
        if admission["schedule_digest"] != sha(schedule_raw):
            fail("SCHEDULE_DIGEST_MISMATCH")
        self.admission = admission.copy()
        self.manifest = strict_json(manifest_raw)
        manifest = self.manifest
        if not isinstance(manifest, dict) or set(manifest) != {"schema", "fixture_id", "storage_agree_value", "ordering", "votes", "moderation", "parent"}:
            fail()
        if manifest["schema"] != CANDIDATE_SCHEMA:
            fail("CANDIDATE_SCHEMA_MISMATCH")
        self.zid = manifest["fixture_id"]
        if not (type(self.zid) is int or isinstance(self.zid, str)):
            fail()
        self.sign = manifest["storage_agree_value"]
        if type(self.sign) is not int or self.sign not in (-1, 1):
            fail()
        # Rev5 item 1: a live profile declares its own normalization, and the
        # tie key must be over the semantic vote; a frozen replay names its
        # pinned order instead. Nothing else is admitted.
        order = manifest["ordering"]
        if isinstance(order, dict):
            if order.get("schema") != "polis-order/1" or not order.get("algorithm_digest"):
                fail()
            if order.get("semantic_vote") != "raw_vote * storage_agree_value":
                fail()
            if order.get("storage_agree_value") != self.sign:
                fail()
        elif not (type(order) is str and order):
            fail()
        self.vote_lines = admitted(self.input_root, manifest["votes"]).splitlines(keepends=True)
        self.mod_lines = admitted(self.input_root, manifest["moderation"]).splitlines(keepends=True)
        self.votes = [strict_json(line) for line in self.vote_lines]
        self.mods = [strict_json(line) for line in self.mod_lines]
        for i, (row, line) in enumerate(zip(self.votes, self.vote_lines), 1):
            if not line.endswith(b"\n") or set(row) != {"slot", "source_ordinal", "stream_ordinal", "created_ms", "pid", "tid", "raw_vote", "weight_x_32767"}:
                fail()
            for key in ("slot", "source_ordinal", "stream_ordinal", "created_ms", "pid", "tid"):
                integer(row[key])
            if row["slot"] != i or type(row["raw_vote"]) is not int or row["raw_vote"] not in (-1, 0, 1):
                fail()
            if row["weight_x_32767"] is not None:
                integer(row["weight_x_32767"], -(2**63))
        for i, row in enumerate(self.mods, 1):
            if set(row) != {"slot", "state"} or row["slot"] != i:
                fail()
            state = row["state"]
            if set(state) != {"mod_out_tids", "mod_in_tids", "meta_tids", "mod_out_ptpts", "lastModTimestamp"}:
                fail()
            for key in ("mod_out_tids", "mod_in_tids", "meta_tids", "mod_out_ptpts"):
                for v in state[key]:
                    integer(v)
        schedule = strict_json(schedule_raw)
        if set(schedule) != {"schema", "operations"} or schedule["schema"] != "polis-schedule/1":
            fail("UNSUPPORTED_VERSION")
        self.schedule = schedule["operations"]
        cfg = p["config"]
        if set(cfg) != {"profile", "seed", "pca_mode", "empty_contract", "init_vector"} or cfg["profile"] != "candidate-profile":
            fail("UNSUPPORTED_VERSION")
        if cfg["pca_mode"] not in ("powerit", "sklearn") or cfg["init_vector"] not in ("ones", "engine-default"):
            fail("UNSUPPORTED_VERSION")
        integer(cfg["seed"])
        if type(cfg["empty_contract"]) is not bool:
            fail()
        os.environ["POLISMATH_PCA_IMPL"] = cfg["pca_mode"]
        random.seed(cfg["seed"])
        np.random.seed(cfg["seed"])
        self.config = cfg
        self.conv = Conversation(self.zid, last_updated=1)
        self.conv.last_updated = 0
        if cfg["init_vector"] == "ones":
            self.conv.pca = {"center": np.zeros(1), "comps": np.array([[1.0], [1.0]])}
        return {"engine": "python-conversation", "admission": self.admission, "profile": "candidate-profile",
                "restore_profiles": ["rebuild-prefix/1"],
                "reset_on_restore": ["raw_rating_mat", "rating_mat", "group_clusterings", "group_k_smoother"],
                "observed_state_cursors": self.cursors()}

    def range(self, p, cursor, count):
        if set(p) != {"from_slot_exclusive", "to_slot_inclusive"}:
            fail()
        start, end = integer(p["from_slot_exclusive"]), integer(p["to_slot_inclusive"])
        if start != cursor or not start < end <= count:
            fail("INVALID_SEQUENCE")
        return start, end

    def apply_votes(self, p):
        start, end = self.range(p, self.vote_cursor, len(self.votes))
        rows = [{"pid": v["pid"], "tid": v["tid"], "created": v["created_ms"],
                 "vote": v["raw_vote"] * self.sign} for v in self.votes[start:end]]
        self.conv = self.conv.update_votes({"votes": rows,
            "lastVoteTimestamp": max([self.conv.last_updated] + [v["created"] for v in rows])}, recompute=False)
        self.vote_cursor = end

    def apply_mods(self, p):
        start, end = self.range(p, self.mod_cursor, len(self.mods))
        for row in self.mods[start:end]:
            # update_moderation ignores empty collections; replace snapshot sets.
            for key in ("mod_out_tids", "mod_in_tids", "meta_tids", "mod_out_ptpts"):
                setattr(self.conv, key, set())
            self.conv = self.conv.update_moderation(row["state"], recompute=False)
        self.mod_cursor = end

    def snapshot(self, p):
        if set(p) != {"checkpoint_id"} or self.compute_id is None:
            fail("INVALID_SEQUENCE")
        name = p["checkpoint_id"]
        if not isinstance(name, str) or not name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in name):
            fail()
        dest = self.output_root / name
        dest.mkdir()  # duplicate checkpoint IDs are errors
        payload = emit_payloads(self.conv, self.zid, self.config["empty_contract"])
        # Restore uses the uncorrected full engine state, not the semantic empty view.
        from polismath.utils.serialization import convert_numpy_types
        files = {}
        for key, value in dict(payload, restore=self.conv.to_dict()).items():
            path = f"{name}/{key}.json"
            raw = json.dumps(value, default=convert_numpy_types, allow_nan=False).encode()
            (self.output_root / path).write_bytes(raw)
            files[key] = descriptor(self.output_root, path)
        manifest = {"schema": "polis-candidate-checkpoint/1", "protocol": PROTOCOL,
            "run_id": self.identity[0], "session_id": self.identity[1], "fixture_id": self.zid,
            "checkpoint_id": name, "compute_id": self.compute_id, "profile": "candidate-profile",
            "admission": self.admission, "output_schema": "polis-candidate-math-output/1", "state_schema": "rebuild-prefix/1",
            "persistence": False, "math_input_cursors": self.math_cursors,
            "observed_state_cursors": self.cursors(), "files": files}
        temp = dest / "manifest.tmp"
        with temp.open("wb") as fh:
            fh.write(json.dumps(manifest, allow_nan=False).encode())
            fh.flush()
            os.fsync(fh.fileno())
        temp.rename(dest / "manifest.json")
        return {"checkpoint_id": name, "manifest": descriptor(self.output_root, f"{name}/manifest.json")}

    def restore(self, p):
        from polismath.conversation.conversation import Conversation
        if self.vote_cursor or self.mod_cursor or self.compute_id is not None:
            fail("INVALID_SEQUENCE")
        if set(p) != {"profile", "parent", "payload", "vote_cursor", "moderation_cursor"} or p["profile"] != "rebuild-prefix/1":
            fail("STATE_INCOMPATIBLE")
        if p["parent"] != self.manifest["parent"] or not p["parent"]:
            fail("STATE_INCOMPATIBLE")
        blob = strict_json(admitted(self.input_root, p["payload"]))
        if blob.get("zid") != self.zid:
            fail("STATE_INCOMPATIBLE")
        self.conv = Conversation.from_dict(blob)
        self.conv.last_updated = 0
        if p["vote_cursor"]:
            self.apply_votes({"from_slot_exclusive": 0, "to_slot_inclusive": p["vote_cursor"]})
        if p["moderation_cursor"]:
            self.apply_mods({"from_slot_exclusive": 0, "to_slot_inclusive": p["moderation_cursor"]})
        return {"observed_state_cursors": self.cursors(), "profile": "rebuild-prefix/1"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-root", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    worker = Adapter(args.input_root, args.output_root)
    logging.disable(logging.CRITICAL)
    while True:
        raw = sys.stdin.buffer.readline(LIMIT + 1)
        if not raw:
            return 0 if worker.state == "CLOSED" else 1
        req = {}
        try:
            if len(raw) > LIMIT or not raw.endswith(b"\n"):
                fail("RESOURCE_LIMIT")
            parsed = strict_json(raw)
            if not isinstance(parsed, dict):
                fail()
            req = parsed
            with contextlib.redirect_stdout(sys.stderr):
                result = worker.handle(req)
            response = {**{k: req[k] for k in ("protocol", "run_id", "session_id", "request_id")},
                        "ok": True, "result": result}
        except Exception as exc:
            code = exc.code if isinstance(exc, ProtocolError) else "COMPUTE_FAILED"
            response = {**{k: req.get(k) for k in ("protocol", "run_id", "session_id", "request_id")},
                        "ok": False, "error": {"code": code, "request_id": req.get("request_id"), "retryable": False}}
            print(json.dumps(response, allow_nan=False), flush=True)
            return 1
        print(json.dumps(response, allow_nan=False), flush=True)
        if worker.state == "CLOSED":
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
