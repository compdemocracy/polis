# Running every check locally

Every check that the hosted CI runs is a small shell script in `ci/local/`, and every
workflow job calls that same script through `make check-<suite>`. A check therefore gives
the same verdict on a laptop, on a build machine or on a hosted runner. Nothing in it
needs GitHub, a cloud account or a secret.

This is for self-hosting groups who want to verify a build before they run it, and for
anyone (people or automated agents) who wants CI's answer before pushing.

## What you need

- Docker with Compose v2.20 or later (`docker compose up --wait` and `docker compose wait`)
  and Buildx. Docker Desktop, colima, OrbStack and plain Linux Docker all work.
- `bash`, `git`, `make`, `curl`.
- Node.js 24 (22 for the Delphi characterization replay). If `mise` is installed, the
  scripts pick the right version from it; otherwise they warn and use the one on `PATH`.
- Python 3.12 (`python3.12` or `python3`). The scripts make their own virtualenvs under
  `.check/venv/`.
- For `check-queue-rs` and `check-coordinator`: `rustup` (the crates pin their toolchains).
- For `check-math`: a `clojure` CLI, or nothing (the script then runs the tests in the
  `clojure:temurin-21-tools-deps` image).

`mkcert` is optional. If it is not on `PATH`, `ci/local/certs.sh` downloads the pinned
v1.4.4 release for your OS and CPU (Linux or macOS, x86-64 or arm64) and checks its
SHA-256. The test certificate authority is created inside the checkout
(`.simulacrum/ca`) and is **never installed** into a system trust store or keychain:
Node is pointed at it with `NODE_EXTRA_CA_CERTS`, and the containers mount
`.simulacrum/certs`.

## One command

```bash
make check            # every check CI runs, in CI's order, then a summary table
make check-fast       # seconds, no containers: sign lint, the two golden guards, contracts, server unit tests, ESLint
make check-changed    # only the suites your change can reach (vs BASE_REF, default origin/edge)
make check-<suite>    # one suite, e.g. make check-server-integration
make check-list       # the suite names
make check-ungated    # test sets that no workflow runs yet
```

`make check` runs every suite even after a failure and exits non-zero if any failed. The
summary is also written to `.check/summary-<time>.txt`. Set `CHECK_STOP=1` to stop at the
first failure.

## The suites

| Suite | Hosted check it is | What it needs |
|---|---|---|
| `vote-path-guard` | Server Integration Tests / vote-path-golden-guard | git; `BASE_REF` |
| `contracts` | Server Integration Tests (contract step) | Node |
| `server-integration` | Server Integration Tests / server-integration-tests | Docker, Node |
| `e2e` | E2E Tests / cypress-run | Docker, Node; host ports 80, 443, 3000 |
| `coordinator` | Coordinator Required Campaign / Coordinator S1/S2 required | Docker, Node, Python, Rust |
| `vote-sign-lint` | Vote convention gate / vote-sign literal lint | Python |
| `vote-gate` | Vote convention gate / two storage conventions | Docker, Node, Python |
| `delphi-characterization` | Delphi characterization / replay | Docker, Node 22, Python |
| `collective-statement-guard` | Collective statement recordings / collective-statement-golden-guard | git; `BASE_REF` |
| `collective-statement` | Collective statement recordings / replay | Docker, Node 22.23.1, Python |
| `lint` | Lint / eslint | Node |
| `delphi-python` | Delphi Python Tests / test | Docker |
| `queue-rs` | queue-rs / queue-rs build, clippy and tests | Docker, Rust |
| `client-alpha` | Client Participation Alpha CI / verify | Node |
| `client-admin` | Run Jest Tests - client admin / test | Node |
| `client-report` | Run Jest Tests - client report / test | Node |
| `math` | Test Math / test-clj | Clojure CLI or Docker |
| `server-unit` | (part of server-integration) | Node |
| `client-participation`, `cdk`, `ci-python` | none yet: entry points, not gates | Node / Python |

Hosted CI runs some of these only when certain paths change (Delphi Python, queue-rs,
the three clients, Test Math, and the coordinator campaign's in-job rule). `make check`
runs all of them regardless; `make check-changed` applies those same path rules
(`ci/local/changed-suites.sh`, which the coordinator job also uses).

## Several stacks on one machine

Each run uses its own Compose project and, if you ask, its own host ports:

- `CHECK_PROJECT=<name>`: the Compose project (lowercase letters, digits, `-`). The
  default is `check-<suite>-<hash of the checkout path>`, so two checkouts never share
  one.
- `CHECK_PORT_BASE=<n>`: move every published host port to `n + offset` (Postgres +0,
  DynamoDB +1, SES +2, MinIO +3, OIDC +4, alpha +5, HTTP +6, HTTPS +7, vote gate +10,
  Delphi characterization +11/+12, queue-rs +13, coordinator +14/+15, collective statement
  +16/+17). The coordinator
  harness needs ports from 55432 to 65000, so a base such as `56000` suits every suite.
  Without it, the ports are CI's (5432, 8000, 3000, 80 and so on).
- Before starting, a run waits (up to `CHECK_PORT_WAIT` seconds, default 600) for its host
  ports to be free, instead of colliding with another stack.
- `CHECK_KEEP=1` leaves the containers running afterwards, for debugging.

The E2E specs address the stack as `http://localhost` and `https://localhost:3000`, so
`check-e2e` always uses ports 80, 443 and 3000: one E2E run per machine at a time.

## Other knobs

- `BASE_REF`: the ref the golden guard and `check-changed` compare with (default
  `origin/edge`; run `git fetch origin edge` first). CI passes the pull request's base.
- `OUT` (vote gate outputs, default `.vote-gate`), `COORDINATOR_OUT` (campaign receipt;
  the campaign requires a new directory outside the checkout, so the default is
  `../.check-runs/<checkout name>/coordinator-<time>` beside it), `DELPHI_COVERAGE_OUT` (the Delphi
  coverage comment, default `.check/<project>/`).
- `CHECK_COORDINATOR_LOCAL=1`: the coordinator campaign judges committed source only (as in
  CI) and refuses a working tree with uncommitted changes; this passes its
  `--allow-local-changes` review mode instead (untracked files still need committing).
- `CHECK_JEST_WORKERS` (server jest workers, default 2, as in CI).

## What stays on the hosted runner

Only publishing: uploading artifacts, the Delphi coverage comment on a pull request, the
Codecov upload, and the deploy and certification workflows. Nothing that decides whether a
change passes needs GitHub.

## Network

Installs and image builds need the network (npm, PyPI, crates.io, Docker Hub, the mkcert
and Cypress downloads, Maven for the Clojure tests). The tests themselves contact nothing
outside the machine, except the Clojure dependency resolution on a cold cache.

## Known differences between a Mac and a hosted runner

- **Clock.** On macOS, Docker runs in a VM with its own clock. Some server tests compare
  a timestamp Postgres wrote with `Date.now()` in the test process, so a VM clock a few
  milliseconds ahead can fail them (for example `conversation-stats` "should accept until
  parameter"). `check-server-integration` prints the measured skew before the tests.
- **CPU architecture.** arm64 and x86-64 produce floating-point results that differ in the
  last digits. The gates compare runs on one machine, so they agree; byte comparisons with
  a recording made on x86-64 do not.

## Files the checks write

Everything goes under `.check/` (state, virtualenvs, the mkcert binary) and
`.simulacrum/` (certificates), both git-ignored, plus each package's `node_modules`. The
tracked `test.env` is never edited: each run writes an edited copy under `.check/`. The
`lint` and `client-report` checks run `npm install` as CI does, which may rewrite a
`package-lock.json` that is out of date.
