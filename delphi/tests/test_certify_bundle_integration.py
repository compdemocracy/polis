"""End-to-end certification-bundle test against a REAL Postgres built from the
polis migrations: seed -> survey -> select -> extract -> push -> pull -> verify.

Opt-in and self-skipping via the shared ``require_polis_postgres`` helper (the
CI ``postgres`` service from ``docker-compose.test.yml`` when
``POLIS_TEST_POSTGRES_URL`` is set, else a THROWAWAY ``postgres:17`` on an
ephemeral port with ``server/postgres/migrations/000000_initial.sql`` +
``000006_update_votes_rule.sql`` applied).

EVERYTHING here is synthetic. Every zid, uid, comment body and vote below was
invented for this file; the planted identifiers exist precisely so the
redaction assertions have something recognisable to fail on.

SCALED THRESHOLDS. The shipped v1 config selects on production scale (V >=
50,000 for the large roles, 16 candidates deep). Seeding ~800k vote rows and
extracting them would make this test useless as a fast gate, so it runs the
shipped config with every ``V``/``P``/``C`` predicate threshold divided by ten
(:func:`scaled_config`) — same roles, same ranks, same ordering, same share
thresholds, same validator. What is under test is the machinery and the rule
semantics, not production's actual population. The shipped thresholds
themselves are covered by ``tests/test_certify_fixture_config.py``.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

from polismath.replay import fixture_bundle as fb
from polismath.replay import fixture_config as fc
from polismath.replay import fixture_extract as fx
from polismath.replay import fixture_survey as fs
from tests.conftest import require_polis_postgres

pytestmark = pytest.mark.integration

# ---------------------------------------------------------------------------
# Planted synthetic identifiers — the redaction assertions look for these.
# ---------------------------------------------------------------------------

PLANTED_TOPIC = "PLANTEDTOPICzzq"
PLANTED_TEXT = "PLANTEDCOMMENTBODYzzq"
PLANTED_UID = 1990001234
Z = {  # role -> synthetic zid
    "revote": 1990000001,
    "banned": 1990000002,
    "zerovote": 1990000003,
    "smallmix": 1990000004,
    "midmix": 1990000005,
    "modheavy": 1990000006,
    "metacold": 1990000007,
    "metawarm": 1990000008,
    "ptptheavy": 1990000009,
    "dense": 1990000010,
}
LARGE_ZIDS = [1990000100 + i for i in range(16)]
ALL_ZIDS = list(Z.values()) + LARGE_ZIDS
PLANTED = [str(z) for z in ALL_ZIDS] + [PLANTED_TOPIC, PLANTED_TEXT, str(PLANTED_UID)]

BASE_MS = 1_600_000_000_000


# ---------------------------------------------------------------------------
# Scaled config.
# ---------------------------------------------------------------------------


def scaled_config() -> dict:
    """The shipped config with every V/P/C threshold >= 10 divided by ten, and
    the generated block reduced to a handful of cheap cases. Structurally and
    semantically identical, and re-validated below."""
    cfg = copy.deepcopy(fc.load_config())
    for role in cfg["roles"]:
        for pred in role["predicates"]:
            if pred["metric"] in ("V", "P", "C") and abs(pred["value"]) >= 10:
                pred["value"] = pred["value"] // 10
    cfg["generated"]["cases"] = [
        c for c in cfg["generated"]["cases"]
        if c["id"] in ("gen-v1-one-voter", "gen-v1-two-voters", "gen-v1-all-pass",
                       "gen-v1-repeated-timestamps", "gen-v1-out-of-order-commits",
                       "gen-v1-dense-stress")
    ]
    cfg["generated"]["cases"] = [
        dict(c, participants=min(c["participants"], 40),
             comments=min(c["comments"], 10),
             votes_per_participant=min(c.get("votes_per_participant", 10), 10))
        for c in cfg["generated"]["cases"]
    ]
    for wl in cfg["workloads"]:
        wl.pop("cache_cap_plus_one_cohort", None)
    cfg["workloads"] = [w for w in cfg["workloads"] if w["kind"] != "churn"]
    fc.validate_config(cfg)
    return cfg


def test_scaled_config_is_still_valid():
    scaled_config()


# ---------------------------------------------------------------------------
# Seeding.
# ---------------------------------------------------------------------------


def _seed(engine):
    """Seed one conversation per role of the SCALED config.

    Shapes (V = vote events, U = unique cells, P = voting participants,
    C = voted comments):

    ==================  =====  =====  ====  ===============================
    zid role            V      P      C     distinguishing feature
    ==================  =====  =====  ====  ===============================
    revote               700     10     50  revote share 0.286
    banned                20      4      5  one voter with participants.mod=-1
    zerovote               0      0      0  3 comments, 2 registered ptpts
    smallmix             500     10     50  clean, V at the small ceiling
    midmix              4000     20    200  clean, largest mid candidate
    modheavy              50      5     10  mod-out share 0.5
    metacold              50      5     10  meta share 0.5
    metawarm              60      6     10  meta share 0.2, mod-out 0
    ptptheavy           2000   1000     20  P >= 1000, C < 500
    dense               1000    100     10  density 1.0, mod-out share 0.3
    large x16          ~5000     20    250  V >= 5000, distinct V ranks
    ==================  =====  =====  ====  ===============================
    """
    import sqlalchemy as sa

    def conv(conn, zid):
        conn.execute(sa.text(
            "INSERT INTO conversations (zid, topic, description, created, modified) "
            "VALUES (:zid, :topic, :descr, :t, :t)"),
            {"zid": zid, "topic": f"{PLANTED_TOPIC}-{zid}",
             "descr": f"{PLANTED_TEXT} description", "t": BASE_MS})

    def ptpts(conn, zid, n, banned=()):
        conn.execute(sa.text(
            "INSERT INTO participants (pid, uid, zid, mod, created) "
            "SELECT g, :uid + g, :zid, CASE WHEN g = ANY(:banned) THEN -1 ELSE 0 END, "
            ":t + g FROM generate_series(0, :n - 1) g"),
            {"zid": zid, "n": n, "uid": PLANTED_UID, "t": BASE_MS,
             "banned": list(banned)})

    def cmts(conn, zid, n, mod_out=0, meta=0):
        conn.execute(sa.text(
            "INSERT INTO comments (tid, zid, pid, uid, txt, mod, is_meta, created, modified) "
            "SELECT g, :zid, 0, :uid, :txt || '-' || g, "
            "       CASE WHEN g < :mod_out THEN -1 ELSE 0 END, "
            "       (g >= :meta_lo AND g < :meta_hi), :t + g, :t + g "
            "FROM generate_series(0, :n - 1) g"),
            {"zid": zid, "n": n, "uid": PLANTED_UID, "txt": PLANTED_TEXT,
             "mod_out": mod_out, "meta_lo": n - meta, "meta_hi": n, "t": BASE_MS})

    def votes(conn, zid, n_p, n_c, extra_revotes=0, votes_per_ptpt=None):
        """Each participant votes on ``votes_per_ptpt`` comments (default all),
        then ``extra_revotes`` additional events revisit already-voted cells."""
        per = n_c if votes_per_ptpt is None else votes_per_ptpt
        conn.execute(sa.text(
            "INSERT INTO votes (zid, pid, tid, vote, created) "
            "SELECT :zid, p, (p + c) % :n_c, "
            "       CASE (p + c) % 3 WHEN 0 THEN -1 WHEN 1 THEN 1 ELSE 0 END, "
            "       :t + p * 1000 + c "
            "FROM generate_series(0, :n_p - 1) p, generate_series(0, :per - 1) c"),
            {"zid": zid, "n_p": n_p, "n_c": n_c, "per": per, "t": BASE_MS})
        if extra_revotes:
            conn.execute(sa.text(
                "INSERT INTO votes (zid, pid, tid, vote, created) "
                "SELECT :zid, g % :n_p, g % :n_c, 1, :t + 900000000 + g "
                "FROM generate_series(0, :n - 1) g"),
                {"zid": zid, "n_p": n_p, "n_c": n_c, "n": extra_revotes,
                 "t": BASE_MS})

    def served_math(conn, zid, rows):
        """A published math_main + math_ticks row per math_env — what the
        engine SERVED, which is what the P-052 §4.5 capture reads back.
        ``rows`` are ``(math_env, last_vote_timestamp, math_tick)`` triples.

        The blob is a synthetic stand-in for the Clojure prep-main whitelist,
        including its ``zid`` key, so the capture's verbatim handling and the
        manifest's redaction claim are both exercised on something recognisable.
        """
        for env, last_vote_ms, math_tick in rows:
            blob = json.dumps({
                "zid": zid, "n": 3, "n-cmts": 3, "tids": [0, 1, 2],
                "lastVoteTimestamp": last_vote_ms,
                "pca": {"center": [0.1, -0.2], "comps": [[1.0, 0.0]]},
            })
            params = {"zid": zid, "env": env, "data": blob, "lvt": last_vote_ms,
                      "ct": math_tick + 100, "mt": math_tick,
                      "mod": last_vote_ms + 1000}
            conn.execute(sa.text(
                "INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, "
                "caching_tick, math_tick, modified) VALUES "
                "(:zid, :env, CAST(:data AS jsonb), :lvt, :ct, :mt, :mod)"), params)
            conn.execute(sa.text(
                "INSERT INTO math_ticks (zid, math_tick, caching_tick, math_env, "
                "modified) VALUES (:zid, :mt, :ct, :env, :mod)"), params)

    with engine.begin() as conn:
        # replica mode disables FK triggers, the tid/pid auto triggers and the
        # votes_latest_unique RULE, so bulk seeding stays fast. The schema
        # itself is the real migration schema.
        conn.execute(sa.text("SET session_replication_role = replica"))

        conv(conn, Z["revote"]); ptpts(conn, Z["revote"], 10)
        cmts(conn, Z["revote"], 50); votes(conn, Z["revote"], 10, 50, extra_revotes=200)

        conv(conn, Z["banned"]); ptpts(conn, Z["banned"], 4, banned=[1])
        cmts(conn, Z["banned"], 5); votes(conn, Z["banned"], 4, 5)

        conv(conn, Z["zerovote"]); ptpts(conn, Z["zerovote"], 2)
        cmts(conn, Z["zerovote"], 3)

        conv(conn, Z["smallmix"]); ptpts(conn, Z["smallmix"], 10)
        cmts(conn, Z["smallmix"], 50); votes(conn, Z["smallmix"], 10, 50)

        conv(conn, Z["midmix"]); ptpts(conn, Z["midmix"], 20)
        cmts(conn, Z["midmix"], 200); votes(conn, Z["midmix"], 20, 200)

        conv(conn, Z["modheavy"]); ptpts(conn, Z["modheavy"], 5)
        cmts(conn, Z["modheavy"], 10, mod_out=5); votes(conn, Z["modheavy"], 5, 10)

        conv(conn, Z["metacold"]); ptpts(conn, Z["metacold"], 5)
        cmts(conn, Z["metacold"], 10, meta=5); votes(conn, Z["metacold"], 5, 10)

        conv(conn, Z["metawarm"]); ptpts(conn, Z["metawarm"], 6)
        cmts(conn, Z["metawarm"], 10, meta=2); votes(conn, Z["metawarm"], 6, 10)

        conv(conn, Z["ptptheavy"]); ptpts(conn, Z["ptptheavy"], 1000)
        cmts(conn, Z["ptptheavy"], 20)
        votes(conn, Z["ptptheavy"], 1000, 20, votes_per_ptpt=2)

        conv(conn, Z["dense"]); ptpts(conn, Z["dense"], 100)
        cmts(conn, Z["dense"], 10, mod_out=3); votes(conn, Z["dense"], 100, 10)

        for i, zid in enumerate(LARGE_ZIDS):
            conv(conn, zid); ptpts(conn, zid, 20); cmts(conn, zid, 250)
            votes(conn, zid, 20, 250, extra_revotes=len(LARGE_ZIDS) - i)

        # Served output for three shapes, so the P-052 §4.5 capture is
        # exercised against every verdict its diagnostic can reach:
        #   revote   — published before the 200 revotes arrived (a tail the
        #              served blob never saw), and in TWO math_envs;
        #   midmix   — published at the newest vote (consistent);
        #   zerovote — a conversation with no votes at all.
        # Every other seeded conversation has NO math_main row, which is the
        # fourth case: a role whose capture is legitimately empty.
        served_math(conn, Z["revote"], [
            ("preprod", BASE_MS + 900000000, 5),
            ("prod", BASE_MS + 900000100, 7),
        ])
        served_math(conn, Z["midmix"], [("prod", BASE_MS + 19199, 3)])
        served_math(conn, Z["zerovote"], [("prod", 0, 0)])

        conn.execute(sa.text("SET session_replication_role = DEFAULT"))


@pytest.fixture(scope="module")
def seeded_db():
    import sqlalchemy as sa

    with require_polis_postgres() as url:
        engine = sa.create_engine(url)
        _seed(engine)
        engine.dispose()
        yield url


@pytest.fixture(scope="module")
def extracted(seeded_db, tmp_path_factory):
    """Run the whole config-driven extraction ONCE and share it."""
    import psycopg2

    root = tmp_path_factory.mktemp("extract")
    payload = root / ".local" / "payload"
    payload.mkdir(parents=True)
    conn = psycopg2.connect(seeded_db)
    try:
        result = fx.extract_from_config(
            conn, config=scaled_config(), payload_root=payload, guard_root=root)
    finally:
        conn.close()
    return root, payload, result


# ---------------------------------------------------------------------------
# Survey + selection against real SQL.
# ---------------------------------------------------------------------------


def test_survey_metrics_match_the_seeded_shapes(seeded_db):
    import psycopg2

    conn = psycopg2.connect(seeded_db)
    try:
        fs.open_readonly_repeatable_read(conn)
        rows = {r["zid"]: r for r in fs.fetch_metrics(conn)}
    finally:
        conn.close()

    revote = rows[Z["revote"]]
    assert revote["V"] == 700 and revote["U"] == 500 and revote["P"] == 10
    assert revote["C"] == 50 and revote["matrix_area"] == 500
    assert revote["revote_share"] == pytest.approx(200 / 700)
    assert revote["density"] == pytest.approx(1.0)

    zero = rows[Z["zerovote"]]
    assert zero["V"] == 0 and zero["all_comments"] == 3
    assert zero["registered_participants"] == 2
    assert zero["revote_share"] is None and zero["density"] is None

    assert rows[Z["banned"]]["banned_voters"] == 1
    assert rows[Z["modheavy"]]["mod_out_share"] == pytest.approx(0.5)
    assert rows[Z["metacold"]]["meta_share"] == pytest.approx(0.5)
    assert rows[Z["metawarm"]]["meta_share"] == pytest.approx(0.2)
    # math_eligible_comments excludes BOTH mod=-1 and is_meta.
    assert rows[Z["metacold"]]["math_eligible_comments"] == 5
    assert rows[Z["modheavy"]]["math_eligible_comments"] == 5
    # Registered participants are recorded separately from matrix rows.
    assert rows[Z["ptptheavy"]]["P"] == 1000
    assert rows[Z["ptptheavy"]]["registered_participants"] == 1000
    assert rows[Z["dense"]]["density"] == pytest.approx(1.0)


def test_every_role_resolves_to_the_intended_conversation(seeded_db):
    import psycopg2

    conn = psycopg2.connect(seeded_db)
    try:
        fs.open_readonly_repeatable_read(conn)
        rows = fs.fetch_metrics(conn)
    finally:
        conn.close()

    sels = {s.slug: s for s in fs.resolve_roles(scaled_config(), rows)}
    assert sels["pc-v1-revote"].zid == Z["revote"]
    assert sels["pc-v1-banned"].zid == Z["banned"]
    assert sels["pc-v1-zerovote"].zid == Z["zerovote"]
    assert sels["pc-v1-smallmix"].zid == Z["smallmix"]
    assert sels["pc-v1-midmix"].zid == Z["midmix"]
    assert sels["pc-v1-modheavy"].zid == Z["modheavy"]
    assert sels["pc-v1-metacold"].zid == Z["metacold"]
    assert sels["pc-v1-metawarm"].zid == Z["metawarm"]
    assert sels["pc-v1-ptptheavy"].zid == Z["ptptheavy"]
    assert sels["pc-v1-dense"].zid == Z["dense"]
    assert sels["pc-v1-dense-max"].zid == Z["dense"]

    # Large ranks 1/2/4/8/16 index into the V-descending remaining list.
    large_by_rank = {1: 0, 2: 1, 4: 3, 8: 7, 16: 15}
    for rank, idx in large_by_rank.items():
        assert sels[f"pc-v1-large-r{rank}"].zid == LARGE_ZIDS[idx], rank

    # The thirteen replacement roles hold thirteen DISTINCT conversations.
    replacement = [s for s in sels.values() if s.group == "replacement"]
    assert len({s.zid for s in replacement}) == len(replacement) == 13


def test_a_missing_role_fails_the_bundle_naming_the_role(seeded_db):
    import psycopg2

    cfg = scaled_config()
    # Ask for a 17th large conversation; only 16 exist.
    cfg["roles"].append(dict(
        next(r for r in cfg["roles"] if r["slug"] == "pc-v1-large-r16"),
        slug="pc-v1-large-r17", role="large-shape-rank-17", rank=17,
        group="stress"))
    conn = psycopg2.connect(seeded_db)
    try:
        fs.open_readonly_repeatable_read(conn)
        rows = fs.fetch_metrics(conn)
    finally:
        conn.close()
    with pytest.raises(fs.RoleUnsatisfied, match="large-shape-rank-17"):
        fs.resolve_roles(cfg, rows)


def test_tie_key_detection_reports_the_live_schema_finding(seeded_db):
    import psycopg2

    conn = psycopg2.connect(seeded_db)
    try:
        tie_key = fx.detect_tie_key(conn)
    finally:
        conn.close()
    # The polis votes table (000000_initial.sql) has no primary key, no unique
    # index and no identity/serial column, so there is no portable event
    # identity and the extract order must be frozen. If this ever changes, the
    # manifest guarantee changes with it and this assertion is the alarm.
    assert tie_key["available"] is False
    assert tie_key["guarantee"] == "frozen-extract-order"
    assert tie_key["order_by"] == "created ASC, ctid ASC"


# ---------------------------------------------------------------------------
# Extraction.
# ---------------------------------------------------------------------------


def test_extraction_writes_one_opaque_directory_per_role(extracted):
    _, payload, result = extracted
    dirs = {p.name for p in payload.iterdir() if p.is_dir()}
    for role in result["roles"]:
        assert role["dir"] in dirs
        # <16 hex>-<slug>: opaque, random, and still glob-compatible.
        prefix, _, slug = role["dir"].partition("-")
        assert len(prefix) == 16 and int(prefix, 16) >= 0
        assert slug == role["slug"]


def test_extracted_event_counts_match_the_survey(extracted):
    _, _, result = extracted
    by_slug = {r["slug"]: r for r in result["roles"]}
    assert by_slug["pc-v1-revote"]["counts"]["vote_events"] == 700
    assert by_slug["pc-v1-revote"]["counts"]["comment_events"] == 50
    assert by_slug["pc-v1-revote"]["counts"]["participants"] == 10
    assert by_slug["pc-v1-zerovote"]["counts"]["vote_events"] == 0
    assert by_slug["pc-v1-zerovote"]["counts"]["comment_events"] == 3
    assert by_slug["pc-v1-ptptheavy"]["counts"]["participants"] == 1000


def test_events_are_lossless_millisecond_and_typed(extracted):
    _, payload, result = extracted
    role = next(r for r in result["roles"] if r["slug"] == "pc-v1-revote")
    lines = (payload / role["dir"] / "events.jsonl").read_text().splitlines()
    events = [json.loads(line) for line in lines]
    assert [e["ord"] for e in events] == list(range(len(events)))
    votes = [e for e in events if e["kind"] == "vote"]
    assert all(isinstance(e["created"], int) and e["created"] > 10 ** 12 for e in votes)
    assert all(isinstance(e["pid"], int) and isinstance(e["tid"], int) for e in votes)
    assert all(e["src"]["table"] == "votes" for e in votes)
    assert [e["src"]["row"] for e in votes] == list(range(len(votes)))
    # Full revote history survives: 700 events over 500 distinct cells.
    assert len({(e["pid"], e["tid"]) for e in votes}) == 500 and len(votes) == 700


def test_compat_csv_is_second_resolution_and_derived_from_the_stream(extracted):
    import csv

    _, payload, result = extracted
    role = next(r for r in result["roles"] if r["slug"] == "pc-v1-revote")
    d = payload / role["dir"]
    events = [json.loads(line) for line in (d / "events.jsonl").read_text().splitlines()]
    votes = [e for e in events if e["kind"] == "vote"]
    with open(d / f"{role['dir']}-votes.csv") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == len(votes)
    for row, event in zip(rows, votes):
        assert int(row["timestamp"]) == event["created"] // 1000
        assert int(row["comment-id"]) == event["tid"]
        assert int(row["voter-id"]) == event["pid"]
        assert int(row["vote"]) == -event["vote"]  # export negates the storage sign


def test_participant_moderation_flags_are_exported(extracted):
    import csv

    _, payload, result = extracted
    role = next(r for r in result["roles"] if r["slug"] == "pc-v1-banned")
    with open(payload / role["dir"] / "participants.csv") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 4
    assert sum(1 for r in rows if int(r["moderation"]) == -1) == 1


def test_comment_text_never_reaches_the_payload(extracted):
    _, payload, _ = extracted
    for path in payload.rglob("*"):
        if path.is_file():
            assert PLANTED_TEXT not in path.read_text(errors="replace"), path


def test_no_planted_identifier_reaches_the_payload(extracted):
    _, payload, _ = extracted
    leaks = []
    for path in payload.rglob("*"):
        if path.is_file():
            leaks += [(path.name, n) for n in
                      fb.scan_public_output(path.read_text(errors="replace"), PLANTED)]
    assert leaks == []


def test_repeat_extraction_yields_identical_logical_events(seeded_db, extracted):
    """The declared tie-order guarantee is 'frozen-extract-order'; within one
    unchanged database the frozen order — and therefore every logical event —
    must reproduce exactly."""
    import psycopg2

    root, payload, first = extracted
    second_root = root.parent / "extract-again"
    second_payload = second_root / ".local" / "payload"
    second_payload.mkdir(parents=True)
    conn = psycopg2.connect(seeded_db)
    try:
        second = fx.extract_from_config(
            conn, config=scaled_config(), payload_root=second_payload,
            guard_root=second_root, dir_names=first["dir_names"])
    finally:
        conn.close()

    a = {r["slug"]: r["logical_digest_sha256"] for r in first["roles"]}
    b = {r["slug"]: r["logical_digest_sha256"] for r in second["roles"]}
    assert a == b and a
    # Reusing the manifest's directory assignment makes the whole payload tree
    # byte-identical too.
    assert fb.root_digest(fb.scan_files(payload)) \
        == fb.root_digest(fb.scan_files(second_payload))


# ---------------------------------------------------------------------------
# Served math rows (P-052 §4.5) against the REAL math_main / math_ticks tables.
# ---------------------------------------------------------------------------


def served_config() -> dict:
    """The scaled config with the served-math capture turned on."""
    cfg = scaled_config()
    cfg["served_math"] = {
        "capture": True,
        "notes": "integration test: capture what the engine served",
    }
    fc.validate_config(cfg)
    return cfg


@pytest.fixture(scope="module")
def extracted_served(seeded_db, tmp_path_factory):
    """The same config-driven extraction, with the capture ON."""
    import psycopg2

    root = tmp_path_factory.mktemp("extract-served")
    payload = root / ".local" / "payload"
    payload.mkdir(parents=True)
    conn = psycopg2.connect(seeded_db)
    try:
        result = fx.extract_from_config(
            conn, config=served_config(), payload_root=payload, guard_root=root,
            include_generated=False)
    finally:
        conn.close()
    return root, payload, result


def test_capture_off_reads_neither_served_table(extracted):
    """The shipped path. Nothing in the payload, nothing in the summaries."""
    _, payload, result = extracted
    assert result["served_math"]["capture"] is False
    assert not any("served_math" in role for role in result["roles"])
    assert not list(payload.rglob("served_math.json"))
    assert not list(payload.rglob("served-math-*.blob.json"))


def test_the_capture_reads_the_real_math_main_columns(seeded_db):
    """Straight at the production schema: every column P-052 §4.5 names is
    selected, comes back typed, and no zid is among them."""
    import psycopg2

    conn = psycopg2.connect(seeded_db)
    try:
        served = fx.fetch_served_math(conn, Z["revote"])
    finally:
        conn.close()
    assert served["math_envs_present"] == ["preprod", "prod"]
    prod = next(r for r in served["math_main"] if r["math_env"] == "prod")
    assert set(prod) == {"math_env", "data_text", "last_vote_timestamp",
                         "caching_tick", "math_tick", "modified"}
    # data::text, so the blob arrives as the bytes Postgres stores rather than
    # as a Python object some later serialisation would have to re-render.
    assert isinstance(prod["data_text"], str)
    assert json.loads(prod["data_text"])["zid"] == Z["revote"]
    assert prod["last_vote_timestamp"] == BASE_MS + 900000100
    assert prod["math_tick"] == 7 and prod["caching_tick"] == 107
    ticks = next(t for t in served["math_ticks"] if t["math_env"] == "prod")
    assert ticks["math_tick"] == 7 and ticks["caching_tick"] == 107


def test_the_capture_writes_one_blob_per_math_env(extracted_served):
    _, payload, result = extracted_served
    revote = next(r for r in result["roles"] if r["slug"] == "pc-v1-revote")
    block = revote["served_math"]
    assert block["math_envs"] == ["preprod", "prod"]
    assert block["math_main_rows"] == 2 and block["math_ticks_rows"] == 2
    directory = payload / revote["dir"]
    for blob in block["blobs"]:
        raw = (directory / blob["file"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == blob["sha256"]
        assert len(raw) == blob["bytes"]
        # Verbatim: this is what production served, zid key and all.
        assert json.loads(raw)["zid"] == Z["revote"]


def test_the_watermark_diagnostic_reaches_every_verdict(extracted_served):
    _, _, result = extracted_served
    by_slug = {r["slug"]: r for r in result["roles"]}

    revote = by_slug["pc-v1-revote"]["served_math"]["consistency"]
    assert revote["gate"] is False
    prod = next(e for e in revote["per_math_env"] if e["math_env"] == "prod")
    # 700 vote events, 200 of them revotes at BASE_MS + 900000000 + g; the
    # publish happened at +900000100, so exactly 99 later revotes are the tail
    # the served blob never saw.
    assert prod["verdict"] == "votes-arrived-after-the-served-watermark"
    assert prod["votes_after_watermark"] == 99
    assert prod["column_matches_blob"] is True

    midmix = by_slug["pc-v1-midmix"]["served_math"]["consistency"]
    entry = midmix["per_math_env"][0]
    assert entry["verdict"] == "consistent"
    assert entry["votes_after_watermark"] == 0

    zerovote = by_slug["pc-v1-zerovote"]["served_math"]["consistency"]
    assert zerovote["per_math_env"][0]["verdict"] == "no-votes-extracted"
    assert zerovote["vote_events"] == 0


def test_a_conversation_production_never_published_captures_an_empty_document(
        extracted_served):
    _, payload, result = extracted_served
    banned = next(r for r in result["roles"] if r["slug"] == "pc-v1-banned")
    assert banned["served_math"]["math_main_rows"] == 0
    assert banned["served_math"]["blobs"] == []
    meta = json.loads(
        (payload / banned["dir"] / "served_math.json").read_text())
    assert meta["math_envs_present"] == [] and meta["captured"] is True


def test_a_captured_bundle_verifies_admits_and_leaks_no_identity(
        extracted_served, tmp_path_factory):
    _, payload, result = extracted_served
    config = served_config()
    config_bytes = fb.canonical_json(config)
    manifest = fb.build_manifest(
        bundle_id="pcb-itest-served-0001", payload_root=payload, config=config,
        config_bytes=config_bytes, selections=result["roles"],
        generated_summaries=result["generated"],
        snapshot={"identifier": "snap-itest", "created_at": "2026-09-07T00:00:00Z",
                  "schema_migration_version": "000018"},
        transaction_guarantee=result["transaction_guarantee"],
        tie_key=result["tie_key"],
        schedules=fb.collect_schedule_hashes(fc.SCRIPTS_DIR / "schedules"),
        owner="polis-certification", extraction_commit="1" * 40,
        source_commit="1" * 40, coverage_report=result["coverage_report"],
    )
    fb.verify(payload, manifest)
    fb.admit_manifest(manifest, config=config, config_bytes=config_bytes)
    # The blobs on disk carry the zid; the manifest must not, and it must say
    # so rather than leaving the blanket redaction claim to cover for it.
    assert not fb.scan_public_output(json.dumps(manifest), PLANTED)
    assert any("VERBATIM" in line and "zid" in line
               for line in manifest["redactions"])
    assert not fb.scan_public_output(
        json.dumps(fb.public_pin(manifest)), PLANTED)


def test_the_loader_reads_the_served_rows_back(extracted_served):
    from polismath.replay import real_data as rd

    _, payload, result = extracted_served
    revote = next(r for r in result["roles"] if r["slug"] == "pc-v1-revote")
    served = rd.read_served_math(payload / revote["dir"])
    assert served is not None
    prod = served.row("prod")
    assert prod is not None
    assert prod.math_tick == 7 and prod.caching_tick == 107
    assert prod.last_vote_timestamp == BASE_MS + 900000100
    assert prod.blob()["lastVoteTimestamp"] == prod.last_vote_timestamp
    assert prod.blob()["zid"] == Z["revote"]
    assert served.tick("preprod") is not None


def test_generated_cases_land_beside_the_extracted_ones(extracted):
    _, payload, result = extracted
    assert result["generated"]
    for case in result["generated"]:
        assert (payload / case["dir"]).is_dir()
        assert case["generated"]["provenance"].startswith("SYNTHETIC")


# ---------------------------------------------------------------------------
# Bundle: push -> pull -> verify (local-filesystem store stand-in).
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def published(extracted, tmp_path_factory):
    _, payload, result = extracted
    bundle_id = "pcb-itest-0001"
    # The roles were selected under the SCALED rules, so that is the config the
    # manifest records and the config admission has to be given: a bundle can
    # only be admitted against the exact rule revision it was built from.
    config = scaled_config()
    config_bytes = fb.canonical_json(config)
    manifest = fb.build_manifest(
        bundle_id=bundle_id, payload_root=payload, config=config,
        config_bytes=config_bytes,
        selections=result["roles"], generated_summaries=result["generated"],
        snapshot={"identifier": "snap-itest", "created_at": "2026-09-07T00:00:00Z",
                  "schema_migration_version": "000018"},
        transaction_guarantee=result["transaction_guarantee"],
        tie_key=result["tie_key"],
        schedules=fb.collect_schedule_hashes(fc.SCRIPTS_DIR / "schedules"),
        owner="polis-certification",
        extraction_commit="1" * 40, source_commit="1" * 40,
        coverage_report=result["coverage_report"],
    )
    provenance = fb.build_provenance(
        bundle_id=bundle_id, root_digest_value=manifest["root_digest"],
        selections=result["provenance_rows"], owner="polis-certification")
    store = fb.LocalStore(tmp_path_factory.mktemp("store"))
    pins = fb.push(store, bundle_id=bundle_id, payload_root=payload,
                   manifest=manifest, provenance=provenance,
                   config=config, config_bytes=config_bytes)
    return store, bundle_id, manifest, provenance, pins


def _admission_kwargs() -> dict:
    """The scaled rules a pull of this bundle must be admitted against."""
    config = scaled_config()
    return {"config": config, "config_bytes": fb.canonical_json(config)}


def test_manifest_records_measured_metrics_without_identities(published):
    _, _, manifest, _, _ = published
    revote = next(r for r in manifest["roles"] if r["slug"] == "pc-v1-revote")
    assert revote["measured_metrics"]["V"] == 700
    assert revote["measured_metrics"]["P"] == 10
    assert "zid" not in revote["measured_metrics"]
    assert not fb.scan_public_output(json.dumps(manifest), PLANTED)


def test_manifest_records_the_transaction_and_ordering_guarantees(published):
    _, _, manifest, _, _ = published
    assert manifest["transaction_guarantee"]["isolation_level"] == "repeatable read"
    assert manifest["transaction_guarantee"]["access_mode"] == "read only"
    assert manifest["transaction_guarantee"]["single_transaction"] is True
    assert manifest["ordering"]["guarantee"] == "frozen-extract-order"
    assert "need not reproduce ctid order" in manifest["ordering"]["note"]
    assert manifest["timestamp_precision"].startswith("integer milliseconds")
    assert manifest["polarity"]["storage_agree_value"] == -1
    assert manifest["polarity"]["export_agree_value"] == 1


def test_provenance_object_holds_the_identities(published):
    _, _, _, provenance, _ = published
    mapping = {r["slug"]: r["zid"] for r in provenance["role_to_zid"]}
    assert mapping["pc-v1-revote"] == Z["revote"]
    assert len(mapping) >= 13


def test_second_operator_pulls_and_verifies_into_an_empty_workspace(
        published, tmp_path):
    store, bundle_id, manifest, _, _ = published
    dest = tmp_path / "operator-two"
    result = fb.pull(store, bundle_id=bundle_id, dest=dest,
                     **_admission_kwargs())
    assert result["root_digest"] == manifest["root_digest"]
    fb.verify(dest / "payload", json.loads((dest / fb.MANIFEST_KEY).read_text()))
    assert not (dest / fb.PROVENANCE_KEY).exists()


def test_corrupted_pull_fails_verification(published, tmp_path):
    store, bundle_id, manifest, _, _ = published
    dest = tmp_path / "corrupt-me"
    fb.pull(store, bundle_id=bundle_id, dest=dest, **_admission_kwargs())
    victim = dest / "payload" / manifest["files"][0]["path"]
    victim.write_bytes(victim.read_bytes()[:-3] + b"XYZ")
    with pytest.raises(fb.VerificationError, match="hash mismatch"):
        fb.verify(dest / "payload", manifest)


def test_republishing_with_different_bytes_is_refused(published, extracted):
    store, bundle_id, manifest, provenance, _ = published
    _, payload, _ = extracted
    with pytest.raises(fb.ImmutabilityError):
        fb.push(store, bundle_id=bundle_id, payload_root=payload,
                manifest=dict(manifest, owner="impostor"), provenance=provenance,
                **_admission_kwargs())


def test_public_pin_leaks_nothing(published):
    _, _, manifest, _, _ = published
    pin = fb.public_pin(manifest)
    text = json.dumps(pin) + fb.render_public_pin_markdown(pin)
    assert not fb.scan_public_output(text, PLANTED)
    assert not fb.scan_public_output(text, ["measured_metrics", '"V":'])
    assert manifest["bundle_id"] in text and manifest["root_digest"] in text


# ---------------------------------------------------------------------------
# CLI: stdout must never carry an identity.
# ---------------------------------------------------------------------------


def test_from_config_cli_stdout_carries_no_identity(seeded_db, tmp_path,
                                                    monkeypatch):
    import importlib.util

    from click.testing import CliRunner

    cli_path = Path(__file__).resolve().parents[1] / "scripts" / "prodclone_extract.py"
    spec = importlib.util.spec_from_file_location("prodclone_extract_cli", cli_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    cfg_path = tmp_path / "scaled_config.json"
    cfg_path.write_text(json.dumps(scaled_config()))
    out = tmp_path / "real_data" / ".local" / "cli-payload"

    result = CliRunner().invoke(mod.cli, [
        "from-config", "--database-url", seeded_db,
        "--from-config", str(cfg_path), "--out", str(out), "--no-generated",
    ])
    assert result.exit_code == 0, result.output
    assert not fb.scan_public_output(result.output, PLANTED)
    assert "pc-v1-revote" in result.output
    assert "frozen-extract-order" in result.output
    # The identities went to the private sidecar, not stdout.
    sidecar = out.parent / f"{out.name}.private"
    rows = json.loads((sidecar / "certify_provenance_rows.json").read_text())
    assert any(r["zid"] == Z["revote"] for r in rows)


def test_from_config_cli_refuses_a_destination_outside_local(seeded_db, tmp_path):
    import importlib.util

    from click.testing import CliRunner

    cli_path = Path(__file__).resolve().parents[1] / "scripts" / "prodclone_extract.py"
    spec = importlib.util.spec_from_file_location("prodclone_extract_cli2", cli_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    result = CliRunner().invoke(mod.cli, [
        "from-config", "--database-url", seeded_db,
        "--out", str(tmp_path / "public-output"),
    ])
    assert result.exit_code != 0
    assert ".local" in result.output
