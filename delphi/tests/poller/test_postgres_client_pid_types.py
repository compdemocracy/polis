"""``PostgresClient.poll_votes`` / ``poll_votes_since`` / ``poll_moderation`` —
pid/tid TYPE parity with Clojure.

ROOT CAUSE (found live, 2026-07-24 poller-equivalence harness debugging,
sessions 2-3): several live-poller ingress points cast ``str(...)`` on pid
and/or tid, while Clojure's poller holds the DB's native INTEGER ids
throughout. Session 2 fixed pid in ``poll_votes``/``poll_votes_since``
(``math_main.base-clusters.members`` divergence). Session 3 (this file's
extension) fixes:

  * tid in ``poll_votes``/``poll_votes_since`` — was masked by the pid
    divergence's sheer volume in the live diff; once pid was fixed, a live
    vw full-run showed the SAME "Type mismatch: golden=int, current=str"
    pattern on ``zid``, every ``tids[i]``, and every
    ``repness.<gid>[i].tid``.
  * tid AND pid in ``poll_moderation`` (the single-zid, full-moderation-state
    variant used by ``update_moderation`` — NOT ``poll_moderation_since``,
    which already returned ``int(m["tid"])``/``int(m["zid"])`` and was never
    broken). Left unfixed, this would have been a LATENT regression
    introduced BY the pid/tid ingress fixes above:
    ``_apply_moderation`` (conversation.py) zeroes moderated-out comment
    COLUMNS via ``[c for c in self.mod_out_tids if c in
    self.rating_mat.columns]`` — with tid now int on the votes side but
    still str from ``poll_moderation``, that intersection would ALWAYS be
    empty, silently disabling comment moderation in the live poller. The
    equivalent participant-ban check (``mod_out_ptpts``) is only exercised
    in 'improved' engine mode (clojure-legacy intentionally leaks bans,
    conversation.py's ``_apply_moderation`` docstring) but was fixed for the
    same consistency reason.

``Conversation.update_votes`` is deliberately type-agnostic at its ingress
(``ptpt_id = vote.get('pid')``/``comment_id = vote.get('tid')  # Preserve
original type``, conversation.py) and ``raw_rating_mat``/``rating_mat`` are
ALWAYS rebuilt fresh from ``poll_votes``/``poll_votes_since`` on every
load-or-init (never restored via ``from_dict`` — see
``polismath/poller/__init__.py``'s "load-or-init finding" docstring) — so
removing these ``str()`` casts is a one-point (per site) fix with no other
code changes needed. The CSV/certify replay driver never cast pid OR tid at
all, and its blobs already matched clj int-for-int across 20 cross-validated
entries (the certified-battery evidence cited when this fix was authorized).

NO live Postgres required — ``PostgresClient.query`` is monkeypatched to
return canned rows (mirrors tests/test_math_writer_numpy_serialization.py's
``_client_capturing()`` pattern), so this exercises the REAL row-mapping code
in postgres.py without a live DB.
"""

from __future__ import annotations

from polismath.database.postgres import PostgresClient, PostgresConfig


def _client_with_canned_rows(rows: list[dict]) -> PostgresClient:
    client = PostgresClient(PostgresConfig(url="postgresql://ignored/db", math_env="t3"))
    client.query = lambda sql, params=None: rows
    return client


class TestPollVotesPidType:
    def test_pid_and_tid_are_native_ints_matching_the_db_column_type(self):
        """``votes.pid``/``votes.tid`` are INTEGER columns (migrations.sql) —
        SQLAlchemy/psycopg2 already return native Python ints for them; this
        just asserts poll_votes does NOT wrap EITHER in str() anymore."""
        client = _client_with_canned_rows(
            [{"zid": 1, "tid": 10, "pid": 5, "vote": -1, "created": 1000}]
        )
        votes = client.poll_votes(zid=1)
        assert len(votes) == 1
        assert votes[0]["pid"] == 5
        assert isinstance(votes[0]["pid"], int)
        assert votes[0]["tid"] == 10
        assert isinstance(votes[0]["tid"], int)

    def test_vote_sign_is_still_flipped_to_delphi_convention(self):
        """The pid/tid-type fix must not disturb the (unrelated) sign flip
        at the same ingress boundary."""
        client = _client_with_canned_rows(
            [{"zid": 1, "tid": 10, "pid": 5, "vote": -1, "created": 1000}]  # raw DB AGREE
        )
        votes = client.poll_votes(zid=1)
        assert votes[0]["vote"] == 1  # Delphi AGREE


class TestPollVotesSincePidType:
    def test_pid_and_tid_are_native_ints(self):
        client = _client_with_canned_rows(
            [{"zid": 1, "tid": 10, "pid": 7, "vote": 1, "created": 2000}]
        )
        votes = client.poll_votes_since(since=0)
        assert len(votes) == 1
        assert votes[0]["pid"] == 7
        assert isinstance(votes[0]["pid"], int)
        assert votes[0]["tid"] == 10
        assert isinstance(votes[0]["tid"], int)

    def test_zid_type_is_unchanged_already_int(self):
        client = _client_with_canned_rows(
            [{"zid": "1", "tid": 10, "pid": 7, "vote": 1, "created": 2000}]
        )
        votes = client.poll_votes_since(since=0)
        assert votes[0]["zid"] == 1
        assert isinstance(votes[0]["zid"], int)

    def test_multiple_rows_preserve_order_and_all_get_int_pids_and_tids(self):
        client = _client_with_canned_rows([
            {"zid": 1, "tid": 10, "pid": 3, "vote": 1, "created": 1000},
            {"zid": 1, "tid": 11, "pid": 9, "vote": -1, "created": 1001},
        ])
        votes = client.poll_votes_since(since=0)
        assert [v["pid"] for v in votes] == [3, 9]
        assert [v["tid"] for v in votes] == [10, 11]
        assert all(isinstance(v["pid"], int) and isinstance(v["tid"], int) for v in votes)


class TestPollModerationPidAndTidType:
    """``poll_moderation`` (the single-zid, full-current-moderation-state
    variant ``update_moderation`` consumes — NOT ``poll_moderation_since``,
    the global-watermark variant, which already used int)."""

    def test_mod_out_tids_are_native_ints(self):
        client = _client_with_canned_rows_for_moderation(
            comments=[{"tid": 5, "modified": 100, "mod": -1, "is_meta": False}],
            participants=[],
        )
        result = client.poll_moderation(zid=1)
        assert result["mod_out_tids"] == [5]
        assert all(isinstance(t, int) for t in result["mod_out_tids"])

    def test_mod_in_tids_are_native_ints(self):
        client = _client_with_canned_rows_for_moderation(
            comments=[{"tid": 7, "modified": 100, "mod": 1, "is_meta": False}],
            participants=[],
        )
        result = client.poll_moderation(zid=1)
        assert result["mod_in_tids"] == [7]
        assert all(isinstance(t, int) for t in result["mod_in_tids"])

    def test_meta_tids_are_native_ints(self):
        client = _client_with_canned_rows_for_moderation(
            comments=[{"tid": 9, "modified": 100, "mod": 0, "is_meta": True}],
            participants=[],
        )
        result = client.poll_moderation(zid=1)
        assert result["meta_tids"] == [9]
        assert all(isinstance(t, int) for t in result["meta_tids"])

    def test_mod_out_ptpts_are_native_ints(self):
        client = _client_with_canned_rows_for_moderation(
            comments=[], participants=[{"pid": 3}],
        )
        result = client.poll_moderation(zid=1)
        assert result["mod_out_ptpts"] == [3]
        assert all(isinstance(p, int) for p in result["mod_out_ptpts"])

    def test_string_valued_mod_column_still_recognized(self):
        """The existing 'support for string values' branch (mod == "1" /
        mod == "-1") must keep working — this fix only changes the id
        TYPES, not the mod-value comparison logic."""
        client = _client_with_canned_rows_for_moderation(
            comments=[{"tid": 4, "modified": 100, "mod": "-1", "is_meta": False}],
            participants=[],
        )
        result = client.poll_moderation(zid=1)
        assert result["mod_out_tids"] == [4]


def _client_with_canned_rows_for_moderation(comments: list[dict], participants: list[dict]) -> PostgresClient:
    """poll_moderation issues TWO queries (comments, then participants) —
    this double-dispatches the monkeypatched ``query`` by SQL text, mirroring
    the FROM-table matching convention already used elsewhere in this test
    suite (e.g. poller_equiv.py's ``_FakeLoopConn``)."""
    client = PostgresClient(PostgresConfig(url="postgresql://ignored/db", math_env="t3"))

    def fake_query(sql, params=None):
        norm = " ".join(sql.lower().split())
        if "from comments" in norm:
            return comments
        if "from participants" in norm:
            return participants
        raise AssertionError(f"unexpected SQL in poll_moderation test: {sql!r}")

    client.query = fake_query
    return client
