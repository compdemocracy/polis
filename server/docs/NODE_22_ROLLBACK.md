# Node 22 Rollback (Prod 500s Incident)

## Problem

After a recent prod deploy from the `stable` branch, the server began throwing
constant `500` errors. Two distinct failure modes were observed in production
logs:

1. **`TypeError: os.tmpDir is not a function`** — thrown in the legacy
   `connect`/`multiparty` body-parsing middleware, before any route handler runs.
   Deterministic: every `multipart/form-data` request 500s.
2. **`ERR_STREAM_PREMATURE_CLOSE`** on `https://www.googleapis.com/oauth2/v4/token`
   during comment creation (`POST /api/v3/comments`). Intermittent (~3 of 24
   comment requests in a sample hour). The comment path synchronously `await`s
   Google Cloud Translate (`detectLanguage` / `translateAndStoreComment` in
   `server/src/comment.ts`), and the OAuth token exchange fails mid-stream, so
   the whole comment POST fails.

## Root Cause

The deploy bumped the prod server runtime to **Node v24** (`docker exec
polis-server-1 node -v` → `v24.17.0`). Both symptoms trace to the v24 jump:

- `os.tmpDir` (camelCase) was a long-deprecated alias **removed in Node 23**. The
  correct API is `os.tmpdir()`. `multiparty@3.3.2` (pulled in transitively via
  `express@3.21.2` → `connect@2.30.2`) still calls `os.tmpDir()` at
  `node_modules/multiparty/index.js:55`, so it throws on Node ≥23.
- Node 24 ships a different bundled `undici`. The intermittent premature-close on
  keep-alive sockets to googleapis is consistent with a v24 undici behavior
  change (one-shot fetches and `wget` to the same endpoint succeed cleanly; only
  the long-running process with a connection pool fails intermittently).

The version was allowed to drift to 24 because `server/package.json` declared
`"node": ">=22 <25"`, and `server/Dockerfile` / `server/mise.toml` pinned `24`.

## Fix (Immediate Rollback)

Scope: **server only** — the directly-affected prod runtime. Smallest blast
radius to stop the bleeding.

| File | Before | After |
| --- | --- | --- |
| `server/Dockerfile` | `FROM docker.io/node:24-alpine` | `FROM docker.io/node:22-alpine` |
| `server/mise.toml` | `node = "24"` | `node = "22"` |
| `server/package.json` (`engines`) | `"node": ">=22 <25"` | `"node": ">=22 <23"` |

Tightening `engines` to `<23` is the guardrail: a future `node:23`/`24` base now
fails the npm engine check at build time instead of blowing up at runtime.

### Validation

```sh
make rebuild-server && docker exec polis-dev-server-1 node -v   # expect v22.x
# then exercise a multipart/form-data upload endpoint and a comment POST locally
```

## Follow-ups (Proper Node 24 Upgrade — Deferred)

The rollback is a stopgap, not the destination. To move to v24 deliberately:

1. **`os.tmpDir` → `os.tmpdir`.** Really an Express 3 / `connect` legacy-stack
   problem; the durable fix is getting off Express 3 (or replacing the
   `multiparty` multipart middleware). A startup shim
   (`os.tmpDir ??= os.tmpdir`) is a viable interim patch if needed.
2. **Make translation best-effort.** Wrap the `detectLanguage` /
   `translateAndStoreComment` awaits in `server/src/comment.ts` so a transient
   Google failure logs + stores the comment untranslated instead of 500ing the
   POST. Worth doing regardless of Node version.
3. **Premature-close hardening.** Investigate undici keep-alive vs. NAT idle
   timeout; consider lowering the keep-alive timeout or adding
   `ERR_STREAM_PREMATURE_CLOSE` to gaxios retry conditions.
4. **Fleet-wide Node bump.** Other services remain on `node:24`
   (`client-participation-alpha` is also a prod SSR runtime; `file-server` and
   the client builds are build-time only). Re-align all services when v24 is
   validated so the fleet isn't split indefinitely.
