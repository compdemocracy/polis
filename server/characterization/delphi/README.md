# Delphi read-route baselines

The PostgreSQL baseline in `recordings-postgres/` contains 272 generated read-route cases across 19 routes, recorded on 2026-10-19 from published commit `c77910845486cb56f6671ee04c4a07715b22ab89`.

Run from `server/` with the disposable local services configured as described
in `main.cjs` and `POSTGRES.txt`:

```sh
node characterization/delphi/main.cjs replay
DELPHI_RESULT_BACKEND=postgres node characterization/delphi/main.cjs replay
```

The first command replays the existing DynamoDB baseline in `recordings/`.
The second loads PostgreSQL result fixtures and archived legacy job controls,
then replays the PostgreSQL baseline byte for byte. The workflow runs both.
`P2ZERO_RECORDINGS_DIR` can select an explicit candidate directory without
changing either committed baseline. No request cases or comparison rules differ
between modes.

`postgres-differences.json` records all 29 changed cases from the DynamoDB
baseline: nine JSON member-order changes and 20 visualization responses. The
latter include the empty visualization list, missing message and per-job lists,
job filtering and order, archived markers, and non-live archived jobs. The other
243 cases are unchanged; none was added or removed. Every change retains its
before/after response and body digest. This is the Delphi lifecycle corpus;
it does not replace the general route-characterization baseline.

Archived pending/running controls are historical fixtures, not native queue
executions. The fixture publisher runs before requests on isolated services,
uses the existing result codec and validating SQL, and writes no vote values.
A failure is a response-byte regression or a fixture/setup error; refresh these
recordings only after reviewing every observable difference.
