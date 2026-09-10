# Historical coordinator reference assets

These seven snapshots replace runtime dependency on unreachable Git objects.
The immutable reference identities, full upstream commits, upstream SHA256s and
vendored SHA256s are recorded in `../inventory-v2.json` under `reference_assets`.
The fold oracle and four other assets preserve the original bytes exactly. The
R09 test module and Postgres adapter have only internal reviewer-name/doc-path
scrubbing in comments/docstrings; executable ASTs are unchanged. Their separate
upstream hashes retain the original provenance without pretending byte identity.

`reference_assets.load_asset` requires the committed vendored bytes to match
their pin. Missing, changed, symlinked or untracked substitute files fail. When
the historical Git object is available its bytes are independently checked against
the upstream pin; absent history is optional and never replaces a missing vendor.
No refresh command regenerates these pins during a candidate campaign.

The `.py.txt` suffix prevents pytest from collecting copied test modules. Only
the original selected fold/mapping/R12 controls and the four cold-reference
adapter modules are loaded. This is the historical oracle, not the live engine.
