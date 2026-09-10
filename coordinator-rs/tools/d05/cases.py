"""Assertions against real HTTP and the reviewed transition/publication APIs."""
import hashlib
import base64
import json
import urllib.parse

import psycopg2
from psycopg2.extras import Json


def pca(c, reader, zid, etag=None):
    headers = {"accept": "application/json", "x-forwarded-proto": "https"}
    if etag is not None:
        headers["if-none-match"] = f'"{etag}"'
    return c.http(reader, "/api/v3/math/pca2?"+urllib.parse.urlencode({"conversation_id": c.capability(zid)}), headers=headers)


def served_shape(raw):
    value = json.loads(raw)
    value.pop("math_tick", None)
    value.pop("caching_tick", None)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def retain_or_compare(c, label, zid, mode, raw):
    c.served = getattr(c, "served", {})
    directory = c.output/"served"
    directory.mkdir(exist_ok=True)
    (directory/f"{label}-{zid}-{mode}.body").write_bytes(raw)
    baseline = {"P-serving": "L-initial", "L-recovered": "P-current"}.get(label, label)
    key = (baseline, zid, mode)
    value = served_shape(raw) if mode in ("cold", "warm", "prefetched") else raw
    if label == "P-serving" and zid == 4:
        return True  # This row was absent in L; its admitted P publication is new.
    if key not in c.served:
        if baseline != label:
            raise AssertionError("missing served baseline")
        c.served[key] = value
    return c.served[key] == value


def consumers(c, reader, label, previous=None):
    status, _, raw = c.http(reader, "/identity", control=2)
    identity = json.loads(raw)
    c.check(f"{label}/{reader}/namespace", status == 200 and identity["math_env"] == c.readers[reader][0], **identity)
    status, _, _ = c.http(reader, "/api/v3/participation?conversation_id="+c.capability(1),
                          headers={"authorization": "Bearer "+c.owner_token})
    c.check(f"{label}/{reader}/owner-token-survives", status == 200, status=status)
    ticks = {}
    cold_bytes = {}
    for zid in range(1,7):
        current = c.query("SELECT math_tick FROM math_main WHERE math_env=%s AND zid=%s", (identity["math_env"],zid))
        expected = current[0][0] if current else 0
        for mode in ("cold", "warm"):
            status, headers, raw = pca(c, reader, zid, previous[zid] if previous else None)
            obj = json.loads(raw) if raw else {}
            c.check(f"{label}/{reader}/{zid}/{mode}", status == 200 and obj.get("math_tick") == expected
                    and retain_or_compare(c, label, zid, mode, raw),
                    status=status, expected_tick=expected, served_tick=obj.get("math_tick"), sha256=hashlib.sha256(raw).hexdigest())
            ticks[zid] = expected
            if mode == "cold":
                cold_bytes[zid] = raw
            else:
                c.check(f"{label}/{reader}/{zid}/warm-bytes", raw == cold_bytes[zid])
        status, _, _ = pca(c, reader, zid, expected)
        c.check(f"{label}/{reader}/{zid}/current-etag", status == 304, status=status)
        for kind, path in (("report", "/api/v3/reports?report_id="+c.report(zid)),
                           ("comments", "/api/v3/comments?conversation_id="+c.capability(zid)),
                           ("participant-votes.csv", f"/api/v3/reportExport/{c.report(zid)}/participant-votes.csv"),
                           ("comment-groups.csv", f"/api/v3/reportExport/{c.report(zid)}/comment-groups.csv")):
            status, _, raw = c.http(reader, path, headers={"x-forwarded-proto": "https"})
            c.check(f"{label}/{reader}/{zid}/{kind}", status == 200 and retain_or_compare(c, label, zid, kind, raw), status=status, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
    status, _, _ = c.http(reader, "/prefetch", control=2)
    c.check(f"{label}/{reader}/prefetch", status == 200)
    for zid in range(1,7):
        status, _, raw = pca(c, reader, zid, previous[zid] if previous else None)
        before, after = json.loads(cold_bytes[zid]), json.loads(raw) if raw else {}
        differences = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
        cursor = c.query("SELECT caching_tick FROM math_main WHERE math_env=%s AND zid=%s", (identity["math_env"],zid))
        # Prefetch deliberately bypasses the template merge used by a cold
        # lookup. Compare each lifecycle with the same lifecycle before the
        # transition; do not invent a new served-shape normalization exception.
        c.check(f"{label}/{reader}/{zid}/prefetched", status == 200
                and (not cursor or after.get("caching_tick") == cursor[0][0])
                and retain_or_compare(c, label, zid, "prefetched", raw), status=status,
                cold_to_prefetch_differences=differences)
    return ticks


def denied(c, label, role, sql, args, code):
    actual = None
    try:
        with psycopg2.connect(f"postgresql://{role}@127.0.0.1:{c.port}/p027") as conn:
            with conn.cursor() as cur:
                cur.execute(sql, args)
    except psycopg2.Error as error:
        actual = error.pgcode
    c.check(label, actual == code, sqlstate=actual, expected=code)


def drain(c, *readers):
    c.dc("stop", *readers)
    for reader in readers:
        ids = c.dc("ps", "-a", "-q", reader).split()
        inspected = json.loads(c.command(["docker", "inspect", *ids]))
        c.check(f"drain/{reader}", len(inspected) == 1 and not inspected[0]["State"]["Running"], container=ids[0])
    # Remove stopped containers as well: the next start has fresh module caches,
    # namespace cursor, TCP pools, and process state.
    c.dc("rm", "-f", *readers)


def exercise(c):
    status, _, raw = c.http("server", "/tokens", control=1)
    assert status == 200
    c.owner_token = json.loads(raw)["owner"]
    claims = json.loads(base64.urlsafe_b64decode(c.owner_token.split(".")[1]+"=="))
    c.query("INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES(%s,1)", (claims["sub"],))
    original = consumers(c, "server", "L-initial")
    consumers(c, "reader_l2", "L-initial")
    c.check("absent-is-not-published-empty", not c.query("SELECT 1 FROM math_main WHERE math_env='legacy' AND zid=4")
            and c.query("SELECT math_tick FROM math_main WHERE math_env='legacy' AND zid=3") == [(0,)])
    status, _, raw = c.http("server", "/participant?conversation="+c.capability(4)+"&uid=400&pid=0", control=2)
    assert status == 200
    missing_headers = {"authorization": "Bearer "+json.loads(raw)["token"]}
    missing_bid = "/api/v3/bid?conversation_id="+c.capability(4)
    status, _, raw = c.http("server", missing_bid, headers=missing_headers)
    c.check("absent-bid/latest", status == 200 and json.loads(raw) == {}, status=status)
    status, _, _ = c.http("server", missing_bid+"&math_tick=0", headers=missing_headers)
    c.check("absent-bid/nonnegative-cursor", status == 500, status=status)
    denied(c, "python-cannot-lease-legacy", "d05_control", "INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('legacy',1,'denied',1,clock_timestamp())", (), "42501")
    denied(c, "legacy-cannot-lease-python", "d05_operator_l", "INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('rustproto',1,'denied',1,clock_timestamp())", (), "42501")
    denied(c, "python-cannot-publish-legacy", "d05_publisher", "SELECT pc_publish('legacy',1,'denied',1,'denied',decode(repeat('00',32),'hex'),NULL,'{}','{}','{}','{}')", (), "P2030")
    denied(c, "ordinary-control-cannot-transition", "d05_control", "SELECT * FROM pc_transition('legacy','rustproto',1,'denied',41,repeat('0',64))", (), "P2030")
    # Negative control: switching config without the floor really does hide the
    # candidate behind the old browser ETag. Retain that actual HTTP failure.
    c.start("reader_p1")
    status, _, _ = pca(c, "reader_p1", 1, original[1])
    c.check("negative/no-floor-old-etag-hides-publication", status == 304, status=status, old_etag=original[1])
    c.dc("stop", "reader_p1")
    c.dc("rm", "-f", "reader_p1")
    def science():
        return {kind: c.query(f"SELECT zid,encode(sha256(convert_to((data-'math_tick'-'caching_tick')::text,'UTF8')),'hex') FROM math_{kind} WHERE math_env='rustproto' ORDER BY zid")
                for kind in ("main", "bidtopid", "ptptstats")}
    initial_science = science()
    for zid in range(1,7):
        c.transition("legacy", "rustproto", zid, original[zid], f"L-to-P-{zid}")
    c.publish("publish-above-L-floors")
    c.check("transition-preserves-science", science() == initial_science, sha256=initial_science)
    # A surviving L instance is observably the wrong serving namespace.
    status, _, raw = c.http("reader_l2", "/identity", control=2)
    c.check("negative/undrained-replica-detected", status == 200 and json.loads(raw)["math_env"] != "rustproto")
    drain(c, "server", "reader_l2")
    c.start("reader_p1", "reader_p2")
    current = consumers(c, "reader_p1", "P-serving", original)
    consumers(c, "reader_p2", "P-serving", original)
    generations = c.query("SELECT zid,math_tick,publisher_epoch,operation_id FROM polis_coordinator_generations WHERE math_env='rustproto' ORDER BY zid,math_tick")
    c.check("Python-only-exact-receipts", len(generations) == 12 and all(r[2] is not None and r[3] for r in generations), count=len(generations))
    # Real protected route: absent and malformed credentials are rejected.
    path = "/api/v3/participation?conversation_id="+c.capability(1)
    for label, headers in (("absent", {}), ("malformed", {"authorization": "Bearer generated-invalid"})):
        status, _, _ = c.http("reader_p1", path, headers=headers)
        c.check(f"auth/{label}", status in (401,403), status=status)
    status, _, raw = c.http("reader_p1", "/participant?conversation="+c.capability(1)+"&uid=100&pid=0", control=2)
    token = json.loads(raw)["token"]
    auth = {"authorization": "Bearer "+token, "content-type": "application/json"}
    status, _, _ = c.http("reader_p1", path, headers=auth)
    c.check("auth/participant-is-not-owner", status == 403, status=status)
    bid_path = "/api/v3/bid?conversation_id="+c.capability(1)
    status, _, raw = c.http("reader_p1", bid_path, headers=auth)
    c.check("auth/participant-bid", status == 200 and isinstance(json.loads(raw).get("bid"), int), status=status)
    # A durable comment-only change changes the admitted source without changing
    # the vote census; both warm readers must observe its new publication.
    votes = c.query("SELECT count(*) FROM votes")[0][0]
    c.query("UPDATE comments SET mod=1,modified=now_as_millis() WHERE zid=1 AND tid=0")
    c.publish("comment-only-publication", (1,))
    c.check("comment-only-no-new-votes", c.query("SELECT count(*) FROM votes")[0][0] == votes)
    for reader in ("reader_p1", "reader_p2"):
        c.http(reader, "/prefetch", control=2)
        status, _, raw = pca(c, reader, 1, current[1])
        c.check(f"comment-only/{reader}", status == 200 and json.loads(raw)["math_tick"] > current[1], status=status)
    current[1] = c.query("SELECT math_tick FROM math_main WHERE math_env='rustproto' AND zid=1")[0][0]
    # The actual HTTP vote path remains available while Python serves.
    status, _, raw = c.http("reader_p1", "/api/v3/votes", method="POST", headers=auth,
                            body=json.dumps({"conversation_id": c.capability(1), "tid": 1, "vote": -1}).encode())
    c.check("continued-vote-intake", status == 200 and c.query("SELECT count(*) FROM votes")[0][0] > votes, status=status)
    c.publish("continued-vote-publication", (1,))
    # Imported durable rows use the same authoritative rebuild path.
    c.query("INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified) VALUES(6,9,0,600,'Generated imported statement',0,false,3000,3000)")
    c.query("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(6,0,9,-1,3001)")
    c.publish("import-publication", (6,))
    current = {zid: c.query("SELECT math_tick FROM math_main WHERE math_env='rustproto' AND zid=%s", (zid,))[0][0] for zid in range(1,7)}
    # Negative torn-row control is observed through a fresh real HTTP export.
    saved, saved_data = c.query("SELECT math_tick,data FROM math_bidtopid WHERE math_env='rustproto' AND zid=1")[0]
    ids = c.query("SELECT data->'base-clusters'->'id' FROM math_main WHERE math_env='rustproto' AND zid=1")[0][0]
    mapping = saved_data["bidToPid"]
    expected_bid = ids[next(i for i, members in enumerate(mapping) if 0 in members)]
    assert len(mapping) > 1, "fixture needs distinguishable base clusters"
    mutant = dict(saved_data, bidToPid=mapping[1:]+mapping[:1])
    c.query("UPDATE math_bidtopid SET math_tick=math_tick+7,data=%s WHERE math_env='rustproto' AND zid=1", (Json(mutant),))
    c.dc("restart", "reader_p2")
    c.ready("reader_p2")
    def participant_headers(reader):
        status, _, raw = c.http(reader, "/participant?conversation="+c.capability(1)+"&uid=100&pid=0", control=2)
        assert status == 200
        return {"authorization": "Bearer "+json.loads(raw)["token"]}
    status, _, raw = c.http("reader_p2", bid_path, headers=participant_headers("reader_p2"))
    c.check("negative/torn-generation-bid-refused", status == 200 and json.loads(raw) == {}, status=status, body=raw.decode())
    # Run the pinned prior handler through the same real app/database mutation.
    old = c.command(["git", "show", "7439947105dfae18bea23c078f229d56e10264d7:server/src/routes/math.ts"])
    old_path = c.output/"prior-math.ts"
    old_path.write_text(old)
    config = json.loads(c.config.read_text())
    config["services"]["reader_p2"]["volumes"].append({"type": "bind", "source": str(old_path),
        "target": "/app/src/routes/math.ts", "read_only": True})
    c.config.write_text(json.dumps(config,indent=2)+"\n")
    c.start("reader_p2")
    status, _, raw = c.http("reader_p2", bid_path, headers=participant_headers("reader_p2"))
    c.check("negative/prior-handler-serves-torn-bid", status == 200 and isinstance(json.loads(raw).get("bid"), int) and json.loads(raw)["bid"] != expected_bid,
            status=status, body=raw.decode(), correct_bid=expected_bid, prior_source_sha256=hashlib.sha256(old.encode()).hexdigest())
    config["services"]["reader_p2"]["volumes"].pop()
    c.config.write_text(json.dumps(config,indent=2)+"\n")
    c.start("reader_p2")
    c.query("UPDATE math_bidtopid SET math_tick=%s,data=%s WHERE math_env='rustproto' AND zid=1", (saved,Json(saved_data)))
    c.dc("restart", "reader_p1", "reader_p2")
    c.ready("reader_p1")
    c.ready("reader_p2")
    consumers(c, "reader_p1", "P-current")
    consumers(c, "reader_p2", "P-current")
    # Absent fallback must fail until an actual coherent recovery bundle exists.
    denied(c, "absent-fallback-requires-bundle", "d05_operator_l", "SELECT * FROM pc_transition('rustproto','legacy',4,'missing-L',%s,repeat('0',64))", (current[4],), "P2031")
    # Refresh the declared content-recovery fixtures from current coherent rows.
    # This isolates transport/clock/provenance behavior from D07 recomputation.
    for zid in range(1,7):
        for table in ("ticks", "bidtopid", "ptptstats", "main"):
            c.query(f"DELETE FROM math_{table} WHERE math_env='legacy' AND zid=%s", (zid,))
        c.snapshot(zid, current[zid])
        c.transition("rustproto", "legacy", zid, current[zid], f"P-to-L-{zid}")
    census = c.query("SELECT count(*) FROM votes")[0][0]
    drain(c, "reader_p1", "reader_p2")
    c.start("server", "reader_l2")
    consumers(c, "server", "L-recovered", current)
    consumers(c, "reader_l2", "L-recovered", current)
    c.check("continued-votes-survive-content-recovery", c.query("SELECT count(*) FROM votes")[0][0] == census, count=census)
    c.check("legacy-does-not-claim-Python-provenance", c.query("SELECT count(*) FROM polis_coordinator_generations WHERE math_env='legacy'")[0][0] == 0)
    c.receipt["transition_receipts"] = c.query("SELECT math_env,zid,source_env,floor_tick,result_tick FROM polis_coordinator_transitions ORDER BY math_env,zid")
