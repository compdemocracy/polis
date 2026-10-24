# Social participant rows

Observable changes: none while off.

GET/HEAD `/api/v3/ptptois` has independent default-off `POLIS_API_PTPTOIS_READS=1` and nginx `RUST_API_ROUTES=ptptois` selectors. Configure `POLIS_API_PTPTOIS_DATABASE_URL`; data reads prefer `READ_ONLY_DATABASE_URL`, authentication uses its own pool. Both pools are read-only,size one,15ms acquire/50ms statements; requests have75ms overall bounds. Nothing shares a participation writer pool or holds a connection across external work.

The public ID is resolved directly each request with no cache. The response appends that supplied ID, so the known warm reverse-cache difference after an owner adds a code does not affect this route. Optional verified participant/OIDC authentication is scoped to the requested conversation. XID, cookie, malformed or unsupported identities hand back. `mod` admits canonical integers; extra/duplicate query fields, bodies and unsupported methods hand back.

The source permits owner, configured ADMIN_UIDS developer, or open-data access. Others receive[]. Optional moderation filtering, the source's99999 participant limit and profile-not-null/XID-not-null join are retained. At most99999 matching participants and one visible social row are admitted because the source has no final order. Oversized strings or multiple visible rows hand back to Node. Top-level nulls disappear; nested xInfo.x_name may remain null. Empty XID/profile strings retain the source's flat shape. Stored markup and Unicode stay intact.

`conformance/ptptois-run.sh` compares unchanged Node and Rust whole HTTP bytes, including HEAD, all auth classes, visibility, moderation, empty/flat/nested/null/multiple rows and all-off cases. Date-only rollovers recapture rather than normalize. DB tests cover permissions, nesting, nulls, read-only enforcement and independent service during a blocked social read. No Node/schema change or rollout is included.
