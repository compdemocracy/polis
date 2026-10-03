#!/usr/bin/env python3
"""Generate the Delphi characterization fixtures (P-077 P2-0).

Writes, deterministically, under ``fixtures/``:

* ``postgres.sql``       users, conversations, reports, comments, votes,
                         participants, OIDC mappings, topic agenda selections
* ``dynamo/<table>.jsonl`` the DynamoDB rows, through the frozen storage codec
                         (``delphi/polismath/delphi_storage/codec.py``)
* ``s3-objects.json``    the visualization objects the S3 listing stub serves
* ``manifest.json``      the ids each case needs, per state

Nine conversations, one per state of P-077 P4 spec section 3: not run, pending,
running, failed, completed, two models, rerun after votes, truncated or invalid
narrative, zero votes. Every value is a generated fixture: no production data,
no real conversation content. The shapes follow the current writers (P-076
catalog; ``801``/``803`` narrative scripts; ``converter.py`` topic names;
``jobs.ts`` queue rows). Run from anywhere; ``--check`` exits non-zero when the
committed files differ from a fresh generation.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
from decimal import Decimal as D

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE / "fixtures"

_spec = importlib.util.spec_from_file_location(
    "delphi_storage_codec", ROOT / "delphi/polismath/delphi_storage/codec.py")
codec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(codec)

CLOCK_MS = 1700000000000  # 2023-11-14T22:13:20Z, the harness's pinned instant
OWNER, ADMIN, OTHER = 1, 2, 3  # uids: conversation owner, global admin, unrelated user
PARTICIPANT_UIDS = list(range(10, 20))
MODEL_A, MODEL_B = "generated-model-alpha", "generated-model-beta"

STATES = [
    (101, "not_run"),
    (102, "pending"),
    (103, "running"),
    (104, "failed"),
    (105, "completed"),
    (106, "two_models"),
    (107, "rerun_after_votes"),
    (108, "truncated_narrative"),
    (109, "zero_vote"),
]


def job_uuid(zid: int, n: int) -> str:
    return f"{zid:08x}-0000-4000-8000-{n:012x}"


def conv_id(zid: int) -> str:
    return f"8p2z{zid}"


def report_id(zid: int) -> str:
    return f"r2p2zero{zid}"


def narrative_json(title: str, cites) -> str:
    return json.dumps({
        "id": "generated_narrative", "title": title,
        "paragraphs": [{"id": "p1", "title": f"{title}: generated paragraph",
                        "sentences": [{"clauses": [{"text": "Generated clause one. ", "citations": list(cites)},
                                                   {"text": "Generated clause two.", "citations": []}]}]}],
    }, separators=(",", ":"))


class Fixture:
    def __init__(self):
        self.sql = []
        self.rows = {name: [] for name in codec.FAMILIES}
        self.s3 = []
        self.manifest = {"clockMs": CLOCK_MS, "codec": codec.CODEC_VERSION, "states": {}}

    def put(self, table, values):
        self.rows[table].append(codec.item_from_python(values))

    # ------------------------------------------------------------ postgres
    def users(self):
        rows = [(OWNER, "Generated Owner", "owner@example.invalid", "p2zero-owner"),
                (ADMIN, "Generated Admin", "admin@example.invalid", "p2zero-admin"),
                (OTHER, "Generated Other", "other@example.invalid", "p2zero-other")]
        rows += [(u, f"Generated Participant {u}", f"participant{u}@example.invalid", f"p2zero-participant-{u}")
                 for u in PARTICIPANT_UIDS]
        values = ",\n ".join(f"({u},'{h}','{e}',{'true' if u <= OTHER else 'false'},'{s}',{CLOCK_MS})"
                             for u, h, e, s in rows)
        self.sql.append(f"INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES\n {values};")
        self.sql.append(f"SELECT setval('users_uid_seq',{max(PARTICIPANT_UIDS)},true);")
        self.sql.append("INSERT INTO oidc_user_mappings(oidc_sub,uid,created) VALUES"
                        f" ('p2zero|owner',{OWNER},{CLOCK_MS}),('p2zero|other',{OTHER},{CLOCK_MS});")

    def conversation(self, zid, state, n_comments, n_participants, vote):
        topic = f"Generated conversation {zid} ({state})"
        self.sql.append(
            "INSERT INTO conversations(zid,owner,topic,description,is_active,is_draft,is_public,profanity_filter,"
            f"spam_filter,created,modified) VALUES({zid},{OWNER},'{topic}','Generated fixture only',true,false,true,"
            f"false,false,{CLOCK_MS - 86400000 * 3},{CLOCK_MS - 86400000 * 3});")
        self.sql.append(f"INSERT INTO zinvites(zid,zinvite,created) VALUES({zid},'{conv_id(zid)}',{CLOCK_MS});")
        self.sql.append(f"INSERT INTO reports(rid,zid,report_id,created,modified) VALUES({zid},{zid},"
                        f"'{report_id(zid)}',{CLOCK_MS - 86400000 * 2},{CLOCK_MS - 86400000 * 2});")
        uids = [OWNER] + PARTICIPANT_UIDS[:n_participants]
        self.sql.append("INSERT INTO participants(zid,uid,created) VALUES "
                        + ",".join(f"({zid},{u},{CLOCK_MS - 86400000 * 3 + i})" for i, u in enumerate(uids)) + ";")
        comments = []
        for t in range(n_comments):
            mod = -1 if t == n_comments - 1 else (0 if t == n_comments - 2 else 1)
            created = CLOCK_MS - 86400000 * 3 + 1000 * (t + 1)
            comments.append(f"({zid},0,{OWNER},'Generated statement {zid}.{t}','en',{created},{created},{mod})")
        self.sql.append("INSERT INTO comments(zid,pid,uid,txt,lang,created,modified,mod) VALUES\n "
                        + ",\n ".join(comments) + ";")
        votes = []
        for p in range(1, n_participants + 1):
            for t in range(n_comments):
                v = vote(p, t)
                if v is not None:
                    votes.append(f"({zid},{p},{t},{v},0,{CLOCK_MS - 86400000 * 2 + 1000 * (p * 100 + t)})")
        if votes:
            self.sql.append("INSERT INTO votes(zid,pid,tid,vote,weight_x_32767,created) VALUES\n "
                            + ",\n ".join(votes) + ";")
        return {"zid": zid, "state": state, "conversation_id": conv_id(zid), "report_id": report_id(zid),
                "rid": zid, "comments": n_comments, "participants": n_participants, "votes": len(votes)}

    def selection(self, zid, pid, job_id, stamp, cluster=1):
        sel = [{"layer_id": 0, "cluster_id": cluster, "topic_key": f"{job_uuid(zid, 1)}#0#{cluster}",
                "archetypal_comments": [{"comment_id": cluster,
                                         "comment_text": f"Generated statement {zid}.{cluster}"}]}]
        self.sql.append(
            "INSERT INTO topic_agenda_selections(zid,pid,archetypal_selections,delphi_job_id,total_selections,"
            f"created_at,updated_at) VALUES({zid},{pid},'{json.dumps(sel, separators=(',', ':'))}',"
            f"{'NULL' if job_id is None else repr(job_id)},1,'{stamp}','{stamp}');")

    # -------------------------------------------------------------- dynamo
    def queue(self, zid, job_id, job_type, status, created, *, started=None, completed=None, results=None,
              logs=(), batch_job_id=None, extra=None):
        row = {"job_id": job_id, "status": status, "created_at": created, "updated_at": completed or started or created,
               "conversation_id": str(zid), "report_id": report_id(zid), "job_type": job_type, "priority": 50,
               "version": 1 + (started is not None) + (completed is not None), "retry_count": 0, "max_retries": 3,
               "timeout_seconds": 7200, "job_config": json.dumps({"job_type": job_type, "report_id": report_id(zid)},
                                                                 separators=(",", ":")),
               "job_results": json.dumps(results, separators=(",", ":")) if results is not None else "{}",
               "logs": json.dumps({"entries": [{"timestamp": ts, "level": lvl, "message": msg} for ts, lvl, msg in logs]},
                                  separators=(",", ":"))}
        if started:
            row.update(started_at=started, worker_id="generated-worker-1")
        if completed:
            row.update(completed_at=completed)
        if batch_job_id:
            row["batch_job_id"] = batch_job_id
        if status in ("COMPLETED", "FAILED"):
            row["process_exit_confirmed"] = True
        row.update(extra or {})
        self.put("Delphi_JobQueue", row)

    def assignments(self, zid, n_comments, outlier=None):
        for t in range(n_comments):
            l0 = -1 if t == outlier else t % 3
            l1 = -1 if t == outlier else t % 2
            self.put("Delphi_CommentHierarchicalClusterAssignments", {
                "conversation_id": str(zid), "comment_id": t, "is_outlier": t == outlier,
                "layer0_cluster_id": l0, "layer1_cluster_id": l1,
                "distance_to_centroid": {"0": D(f"0.{t + 1}25"), "1": D(f"0.{t + 2}5")},
                "cluster_confidence": {"0": D(f"0.9{t}"), "1": D(f"0.8{t}")}})

    def keywords(self, zid):
        for layer, n in ((0, 3), (1, 2)):
            for c in range(n):
                self.put("Delphi_CommentClustersStructureKeywords", {
                    "conversation_id": str(zid), "cluster_key": f"layer{layer}_{c}", "layer_id": layer, "cluster_id": c,
                    "topic_label": f"Generated keywords {layer}.{c}", "size": 2 + c,
                    "sample_comments": [f"Generated statement {zid}.{c}"],
                    "centroid_coordinates": {"x": D(f"{c}.5"), "y": D(f"-{layer}.25")},
                    "top_words": ["generated", f"word{c}"], "top_tfidf_scores": [D("0.5"), D("0.25")],
                    **({"parent_cluster": {"layer_id": 1, "cluster_id": c % 2}} if layer == 0 else
                       {"child_clusters": [{"layer_id": 0, "cluster_id": k} for k in range(3) if k % 2 == c]})})

    def graph(self, zid, n_comments):
        for t in range(n_comments):
            self.put("Delphi_UMAPGraph", {
                "conversation_id": str(zid), "edge_id": f"{t}_{t}", "source_id": t, "target_id": t, "weight": 1,
                "distance": 0, "is_nearest_neighbor": True, "shared_cluster_layers": [],
                "position": {"x": D(f"{t}.125"), "y": D(f"-{t}.5")}})
            if t + 1 < n_comments:
                self.put("Delphi_UMAPGraph", {
                    "conversation_id": str(zid), "edge_id": f"{t}_{t + 1}", "source_id": t, "target_id": t + 1,
                    "weight": D("0.75"), "distance": D("0.25"), "is_nearest_neighbor": t % 2 == 0,
                    "shared_cluster_layers": [0] if t % 3 == (t + 1) % 3 else []})

    def topics(self, zid, job, model, created):
        keys = []
        for layer, n in ((0, 3), (1, 2)):
            for c in range(n):
                key = f"{job}#{layer}#{c}"
                keys.append(key)
                self.put("Delphi_CommentClustersLLMTopicNames", {
                    "conversation_id": str(zid), "topic_key": key, "layer_id": layer, "cluster_id": c,
                    "topic_name": f"Generated topic {layer}.{c} by {model.rsplit('-', 1)[1]}",
                    "model_name": model, "created_at": created, "job_id": job})
        return keys

    def narratives(self, zid, checker, batch, model, base_ts, topic_keys, *, oldest_topic=True, data=None,
                   missing_job=False):
        rid = report_id(zid)
        sections = [f"{batch}_global_groups", f"{batch}_global_group_informed_consensus", f"{batch}_global_uncertainty"]
        tsections = [k.replace("#", "_") for k in topic_keys]
        order = (tsections + sections) if oldest_topic else (sections + tsections)
        written = []
        for i, sec in enumerate(order):
            ts = f"{base_ts}.{i + 1:06d}+00:00"
            row = {"rid_section_model": f"{rid}#{sec}#{model}", "timestamp": ts, "report_id": rid, "section": sec,
                   "model": model, "report_data": (data or {}).get(sec, narrative_json(f"Generated {sec}", [0, 1])),
                   "batch_id": f"msgbatch_generated_{zid}"}
            if not missing_job:
                row["job_id"] = checker
            self.put("Delphi_NarrativeReports", row)
            written.append(sec)
        return written

    def statement(self, zid, topic_key, n, created, model=MODEL_A):
        layer, cluster = topic_key.split("#")[1:]
        key = f"{zid}#{topic_key}#{job_uuid(zid, 0xc000 + n)}"
        self.put("Delphi_CollectiveStatement", {
            "zid_topic_jobid": key, "zid": str(zid), "topic_key": topic_key,
            "topic_name": f"Generated topic {layer}.{cluster}",
            "statement_data": json.dumps({"paragraphs": [{"id": "s1", "title": f"Generated statement {n}",
                                                          "sentences": [{"clauses": [{"text": "Generated.",
                                                                                      "citations": [0]}]}]}]},
                                         separators=(",", ":")),
            "comments_data": json.dumps([{"comment_id": 0, "comment_text": f"Generated statement {zid}.0",
                                          "total_votes": 3}], separators=(",", ":")),
            "created_at": created, "model": model})
        return key

    def images(self, zid, job):
        for name, size in (("layer_0_datamapplot.html", 20480), ("layer_0_static.png", 4096),
                           ("layer_1_datamapplot.html", 20481), ("layer_1_presentation.png", 4097),
                           ("layer_1_static.svg", 2048), ("summary.json", 64), ("overview.html", 512)):
            self.s3.append({"Key": f"visualizations/{report_id(zid)}/{job}/{name}", "Size": size,
                            "LastModified": "2023-11-14T20:35:00.000Z"})

    # -------------------------------------------------------------- states
    def build(self):
        self.users()
        votes = lambda p, t: [-1, 1, 0, None][(p * 3 + t) % 4]  # noqa: E731
        for zid, state in STATES:
            n_comments = {107: 10, 109: 6}.get(zid, 8)
            m = self.conversation(zid, state, n_comments, 6, (lambda p, t: None) if state == "zero_vote" else votes)
            m["jobs"], m["statements"], m["topic_keys"], m["sections"], m["selections"] = {}, [], [], {}, []
            getattr(self, "state_" + state)(zid, m)
            self.manifest["states"][state] = m

    def state_not_run(self, zid, m):
        pass

    def state_pending(self, zid, m):
        j = job_uuid(zid, 1)
        self.queue(zid, j, "FULL_PIPELINE", "PENDING", "2023-11-14T22:00:00.000Z")
        self.put("Delphi_JobActiveGuard", {
            "guard_key": f"scope#FULL_PIPELINE#{zid}#{report_id(zid)}", "job_id": j, "job_type": "FULL_PIPELINE",
            "conversation_id": str(zid), "report_id": report_id(zid), "config_hash": "generated-config-hash",
            "version": 1, "created_at": "2023-11-14T22:00:00.000Z", "updated_at": "2023-11-14T22:00:00.000Z"})
        m["jobs"] = {"pipeline": j}

    def state_running(self, zid, m):
        j = job_uuid(zid, 1)
        self.queue(zid, j, "FULL_PIPELINE", "PROCESSING", "2023-11-14T21:50:00.000Z",
                   started="2023-11-14T21:51:00.000Z",
                   logs=[("2023-11-14T21:51:00.000000", "INFO", "Starting FULL_PIPELINE"),
                         ("2023-11-14T21:55:00.000000", "INFO", "[stdout] Clustering complete")])
        self.assignments(zid, m["comments"], outlier=3)
        self.keywords(zid)
        self.graph(zid, m["comments"])
        m["jobs"] = {"pipeline": j}

    def state_failed(self, zid, m):
        j = job_uuid(zid, 1)
        self.queue(zid, j, "FULL_PIPELINE", "FAILED", "2023-11-14T21:00:00.000Z",
                   started="2023-11-14T21:01:00.000Z", completed="2023-11-14T21:20:00.000Z",
                   results={"status": "failed", "error": "stage_failed:topic_naming"},
                   logs=[("2023-11-14T21:01:00.000000", "INFO", "Starting FULL_PIPELINE"),
                         ("2023-11-14T21:20:00.000000", "ERROR", "Topic naming stage exited with status 1")],
                   extra={"error_message": "stage_failed:topic_naming"})
        self.assignments(zid, m["comments"], outlier=3)
        self.keywords(zid)
        self.graph(zid, m["comments"])
        m["jobs"] = {"pipeline": j}

    def _completed(self, zid, m, j, model, day, *, n=1, oldest_topic=True, data=None, missing_job=False,
                   narratives=True):
        self.queue(zid, j, "FULL_PIPELINE", "COMPLETED", f"{day}T19:00:00.000Z", started=f"{day}T19:01:00.000Z",
                   completed=f"{day}T19:30:00.000Z",
                   results={"status": "completed", "result_type": "FULL_PIPELINE"},
                   logs=[(f"{day}T19:01:00.000000", "INFO", "Starting FULL_PIPELINE"),
                         (f"{day}T19:30:00.000000", "INFO",
                          f"[stdout] Results stored in DynamoDB for conversation {zid}")])
        keys = self.topics(zid, j, model, f"{day}T19:20:0{n}.000000")
        m["topic_keys"] += keys
        m["jobs"][f"pipeline{n}"] = j
        if not narratives:
            return keys
        batch = f"batch_report_{report_id(zid)}_{1699990000 + n}_{zid}{n}"
        checker = f"batch_check_{report_id(zid)}_{1699990100 + n}_{zid}{n}"
        self.queue(zid, batch, "CREATE_NARRATIVE_BATCH", "COMPLETED", f"{day}T19:40:00.000Z",
                   started=f"{day}T19:41:00.000Z", completed=f"{day}T19:42:00.000Z",
                   results={"status": "submitted", "batch_id": f"msgbatch_generated_{zid}"},
                   extra={"batch_id": f"msgbatch_generated_{zid}", "model": model})
        self.queue(zid, checker, "AWAITING_NARRATIVE_BATCH", "COMPLETED", f"{day}T19:42:00.000Z",
                   started=f"{day}T19:50:00.000Z", completed=f"{day}T19:51:00.000Z", batch_job_id=batch,
                   results={"status": "completed", "processed": 8},
                   extra={"batch_id": f"msgbatch_generated_{zid}"})
        m["jobs"][f"batch{n}"], m["jobs"][f"checker{n}"] = batch, checker
        m["sections"][checker] = self.narratives(zid, checker, batch, model, f"{day}T19:51:0{n}", keys,
                                                 oldest_topic=oldest_topic, data=data, missing_job=missing_job)
        self.images(zid, j)
        return keys

    def state_completed(self, zid, m):
        keys = self._completed(zid, m, job_uuid(zid, 1), MODEL_A, "2023-11-14")
        self.assignments(zid, m["comments"], outlier=4)
        self.keywords(zid)
        self.graph(zid, m["comments"])
        m["statements"] += [self.statement(zid, keys[1], 1, "2023-11-14T20:10:00.000Z"),
                            self.statement(zid, keys[1], 2, "2023-11-14T20:20:00.000Z"),
                            self.statement(zid, keys[3], 3, "2023-11-14T20:15:00.000Z")]
        self.selection(zid, 1, m["jobs"]["checker1"], "2023-11-14T21:00:00+00")
        # pid 3's topic (layer 0, cluster 2) holds tids 2 and 5; pid 3 voted on 5 only,
        # so the topical next-comment pool is exactly tid 2 (no SQL random() tie).
        self.selection(zid, 3, m["jobs"]["checker1"], "2023-11-14T21:05:00+00", cluster=2)
        m["selections"] = [1, 3]

    def state_two_models(self, zid, m):
        # Two pipeline runs on one day with different models, plus a third run with the
        # second model on the same day (the model+day merge the topic route performs).
        self._completed(zid, m, job_uuid(zid, 1), MODEL_A, "2023-11-14", n=1, oldest_topic=False)
        self._completed(zid, m, job_uuid(zid, 2), MODEL_B, "2023-11-14", n=2)
        self.topics(zid, job_uuid(zid, 3), MODEL_B, "2023-11-14T19:25:00.000000")
        self.queue(zid, job_uuid(zid, 3), "FULL_PIPELINE", "COMPLETED", "2023-11-14T19:10:00.000Z",
                   started="2023-11-14T19:11:00.000Z", completed="2023-11-14T19:26:00.000Z",
                   results={"status": "completed", "result_type": "FULL_PIPELINE"})
        m["jobs"]["pipeline3"] = job_uuid(zid, 3)
        self.assignments(zid, m["comments"], outlier=5)
        self.keywords(zid)
        self.graph(zid, m["comments"])

    def state_rerun_after_votes(self, zid, m):
        # First run on 2023-11-13; new votes and comments; second run on 2023-11-14.
        # The second run's reset removed the first run's topics, narratives and images,
        # so only its queue rows and a participant selection stamped with it remain.
        old, old_checker = job_uuid(zid, 1), f"batch_check_{report_id(zid)}_1699900100_{zid}0"
        self.queue(zid, old, "FULL_PIPELINE", "COMPLETED", "2023-11-13T09:00:00.000Z",
                   started="2023-11-13T09:01:00.000Z", completed="2023-11-13T09:30:00.000Z",
                   results={"status": "completed", "result_type": "FULL_PIPELINE"})
        self.queue(zid, old_checker, "AWAITING_NARRATIVE_BATCH", "COMPLETED", "2023-11-13T09:42:00.000Z",
                   started="2023-11-13T09:50:00.000Z", completed="2023-11-13T09:51:00.000Z",
                   batch_job_id=f"batch_report_{report_id(zid)}_1699900000_{zid}0", results={"status": "completed"})
        m["jobs"]["pipeline_old"], m["jobs"]["checker_old"] = old, old_checker
        keys = self._completed(zid, m, job_uuid(zid, 2), MODEL_A, "2023-11-14", n=2)
        self.assignments(zid, m["comments"], outlier=7)
        self.keywords(zid)
        self.graph(zid, m["comments"])
        m["statements"].append(self.statement(zid, keys[0], 1, "2023-11-14T20:30:00.000Z"))
        self.selection(zid, 1, old_checker, "2023-11-13T12:00:00+00")
        self.selection(zid, 2, m["jobs"]["checker2"], "2023-11-14T21:00:00+00")
        m["selections"] = [1, 2]

    def state_truncated_narrative(self, zid, m):
        j = job_uuid(zid, 1)
        batch = f"batch_report_{report_id(zid)}_1699990001_{zid}1"
        data = {
            f"{batch}_global_group_informed_consensus": '{"id":"generated_narrative","paragraphs":[{"title":"Gener',
            f"{batch}_global_uncertainty": "not json at all",
        }
        keys = self._completed(zid, m, j, MODEL_A, "2023-11-14", data=data)
        # A section stored as a map rather than a JSON string, and two legacy rows: one
        # without a job id (grouped as unknown_job_<date>) and one two-part key (model "unknown").
        rid = report_id(zid)
        self.rows["Delphi_NarrativeReports"].append({
            "rid_section_model": {"S": f"{rid}#{keys[0].replace('#', '_')}#{MODEL_B}"},
            "timestamp": {"S": "2023-11-14T19:52:00.000001+00:00"}, "report_id": {"S": rid},
            "section": {"S": keys[0].replace("#", "_")}, "model": {"S": MODEL_B},
            "report_data": {"M": {"id": {"S": "generated_map_form"}, "paragraphs": {"L": []}}},
            "job_id": {"S": m["jobs"]["checker1"]}})
        self.put("Delphi_NarrativeReports", {"rid_section_model": f"{rid}#global_groups#{MODEL_A}",
                                              "timestamp": "2023-11-12T08:00:00.000000+00:00", "report_id": rid,
                                              "section": "global_groups", "model": MODEL_A,
                                              "report_data": narrative_json("Legacy groups", [2])})
        self.put("Delphi_NarrativeReports", {"rid_section_model": f"{rid}#legacy_consensus",
                                              "timestamp": "2023-11-12T08:00:01.000000+00:00", "report_id": rid,
                                              "report_data": "", "job_id": "legacy-generated-job"})
        self.assignments(zid, m["comments"], outlier=2)
        self.keywords(zid)
        self.graph(zid, m["comments"])

    def state_zero_vote(self, zid, m):
        none = json.dumps({"id": "polis_narrative_error_message", "title": "No votes",
                           "paragraphs": [{"id": "polis_narrative_error_message", "title": "No votes",
                                           "sentences": [{"clauses": [{"text": "There are no votes yet.",
                                                                       "citations": []}]}]}]},
                          separators=(",", ":"))
        batch = f"batch_report_{report_id(zid)}_1699990001_{zid}1"
        keys_data = {f"{batch}_global_{s}": none for s in ("groups", "group_informed_consensus", "uncertainty")}
        self._completed(zid, m, job_uuid(zid, 1), MODEL_A, "2023-11-14", data=keys_data)
        self.assignments(zid, m["comments"])
        self.keywords(zid)
        self.graph(zid, m["comments"])

    # ---------------------------------------------------------------- write
    def files(self):
        out = {"postgres.sql": ("-- Generated by server/characterization/delphi/generate.py. Generated fixture only.\n"
                                "-- Same pinned instant as the server clock (1700000000000).\n"
                                "CREATE OR REPLACE FUNCTION now_as_millis() RETURNS BIGINT AS $$ "
                                "SELECT 1700000000000::bigint $$ LANGUAGE SQL;\n"
                                + "\n".join(self.sql) + "\n").encode()}
        for table, items in sorted(self.rows.items()):
            if items:
                out[f"dynamo/{table}.jsonl"] = codec.encode_family(table, items)
        out["s3-objects.json"] = (json.dumps(sorted(self.s3, key=lambda o: o["Key"]), indent=1) + "\n").encode()
        out["manifest.json"] = (json.dumps(self.manifest, indent=1, sort_keys=True) + "\n").encode()
        return out


def main(argv):
    fx = Fixture()
    fx.build()
    files = fx.files()
    if "--check" in argv:
        bad = [n for n, b in files.items() if not (OUT / n).exists() or (OUT / n).read_bytes() != b]
        extra = sorted(str(p.relative_to(OUT)) for p in OUT.rglob("*") if p.is_file()
                       and str(p.relative_to(OUT)) not in files)
        if bad or extra:
            print("fixtures differ from a fresh generation:", bad, "unexpected:", extra, file=sys.stderr)
            return 1
        print(f"fixtures match ({len(files)} files)")
        return 0
    for name, data in files.items():
        (OUT / name).parent.mkdir(parents=True, exist_ok=True)
        (OUT / name).write_bytes(data)
    print(f"wrote {len(files)} files under {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
