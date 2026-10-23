# Bucket membership and group locations

Observable changes: none while off.

GET/HEAD `/api/v3/bid` and `/api/v3/locations` have independent default-off process switches `POLIS_API_BID_READS=1` and `POLIS_API_LOCATIONS_READS=1`, DSNs `POLIS_API_BID_DATABASE_URL` and `POLIS_API_LOCATIONS_DATABASE_URL`, and nginx selectors `bid` and `locations`. Reads prefer READ_ONLY_DATABASE_URL. Each has independent size-one read-only identity/data pools,15ms acquire/50ms statement/75ms request limits. Every request resolves its supplied public ID directly; there is no ID cache. No DB lease crosses external work; no writer pool, new lock or migration is used.

A bounded, shared three-second cache retains a whole coherent math generation by environment and numeric conversation. One SQL snapshot joins main, mapping, participant stats and tick, each with matching generation. The current Node implementation loads bundles on demand; it has no active prefetch timer. Missing/incoherent generations preserve the source's empty responses and tick checks; malformed/oversized data, stale bid requests and unsupported inputs hand back. Main/mapping JSON is bounded at64KiB each. Typed mapping preserves unplaced buckets, missing labels (-1), first PID mapping, final duplicate bucket index and numeric group index.

Bid requires verified scoped participant/OIDC identity and existing membership; locations accepts optional identity. XID/cookie/creation paths remain on Node. Locations preserve JS number rendering and source row shape. With no final source ordering, at most one matching location is admitted; multiple matching rows hand back. PID lists are capped at16384. Distinct switches and pools preserve participation under resource pressure. Raw recordings compare whole unchanged-Node HTTP bytes across ticks, cache expiry, identity and admission boundaries; DB tests verify cache behavior, readonly enforcement and independent service during a stalled read.

The cache is local to this process and shared by these two Rust routes. Node participation/report callers can warm its separate cache; concurrent publications can therefore yield different generations within the three-second window, as documented for the existing Rust math routes. The recordings prove controlled cold/warm/expiry behavior, not equivalence under every cross-process publication schedule.

The JS-to-TS comparison found no semantic conversion slip. Current coherent-bundle and default-tick behavior are later changes and are preserved. No Node/schema change or rollout is included.
