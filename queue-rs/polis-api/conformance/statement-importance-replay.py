"""Check exact typed JSON body bytes; the database read timestamp is dynamic."""
import http.client
import json
import os
import sys
import time

PATH = "/api/v3/statements/importance"
PORT = int(os.environ["IMPORTANCE_API_PORT"])
OFF = int(os.environ["IMPORTANCE_OFF_PORT"])
checks = []


def request(path=PATH + "?conversation_id=fixture", method="GET", headers=None, body=None, port=PORT):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request(method, path, body=body, headers=headers or {})
    r = c.getresponse()
    result = r.status, dict(r.getheaders()), r.read()
    c.close()
    return result


def check(name, condition):
    assert condition, name
    checks.append(name)


for port in [PORT, OFF]:
    for attempt in range(60):
        try:
            if request("/health", port=port)[0] == 200:
                break
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.1)
    else:
        raise RuntimeError("readiness")

for name, headers in [("anonymous", {}), ("participant-cookie", {"Cookie": "participant=fixture"}),
                      ("irrelevant-bearer", {"Authorization": "Bearer unused"})]:
    before = int(time.time() * 1000)
    status, h, body = request(headers=headers)
    value = json.loads(body)
    expected = {"schema": "statement-importance/1", "conversation_id": "fixture",
                "read_at_ms": value["read_at_ms"], "statements": [
                    {"tid": 0, "important": 1, "voters": 3},
                    {"tid": 2, "important": 0, "voters": 1},
                    {"tid": 4, "important": 0, "voters": 0},
                    {"tid": 5, "important": 1, "voters": 1},
                    {"tid": 9, "important": 1, "voters": 1}]}
    check(name + "/bytes", status == 200 and body == json.dumps(expected, separators=(",", ":")).encode())
    check(name + "/timestamp", before - 1000 <= value["read_at_ms"] <= int(time.time() * 1000) + 1000)
    check(name + "/content-length", int(h["Content-Length"]) == len(body))
status, h, body = request(method="HEAD")
check("head", status == 200 and body == b"" and int(h["Content-Length"]) > 0)
status, _, body = request(PATH + "?conversation_id=empty")
check("zero-statements", status == 200 and json.loads(body)["statements"] == [])
status, _, body = request(PATH + "?conversation_id=other")
check("conversation-scope", status == 200 and json.loads(body)["statements"] == [{"tid": 0, "important": 1, "voters": 1}])
status, _, body = request(PATH + "?conversation_id=strict")
check("strict-visibility", status == 200 and json.loads(body)["statements"] == [{"tid": 1, "important": 1, "voters": 1}])
check("missing", request(PATH + "?conversation_id=missing")[0] == 404)
check("off", request(port=OFF)[0] == 502)
for query in ["", "conversation_id=", "conversation_id=fixture&conversation_id=other", "conversation_id[]=fixture",
              "conversation_id=" + "x" * 101, "conversation_id=fixture&other=x", "conversation_id=%zz"]:
    check("query/" + query, request(PATH + "?" + query)[0] == 502)
for method, body in [("POST", None), ("OPTIONS", None), ("GET", "{}")]:
    check("method-body/" + method, request(method=method, body=body)[0] == 502)
result = {"passed": len(checks), "failed": 0, "checks": checks,
          "fixture": "aggregate metadata with integer participant numbers, no vote values or text",
          "timestamp": "database statement start checked against request interval; exact body order and fields checked"}
with open(sys.argv[1], "w") as f:
    json.dump(result, f, indent=2)
    f.write("\n")
print(f"statement importance: {len(checks)} passed", file=sys.stderr)
