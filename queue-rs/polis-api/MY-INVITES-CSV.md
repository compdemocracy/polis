# Participant-owned invitation CSV

Observable changes: none while off.

GET/HEAD `/api/v3/treevite/myInvites/csv` has its own default-off `POLIS_API_MY_INVITES_CSV_READS=1` process switch and nginx `RUST_API_ROUTES=myInvitesCsv` selector. Configure `POLIS_API_MY_INVITES_CSV_DATABASE_URL`; reads prefer READ_ONLY_DATABASE_URL. Independent size-one read-only auth/data pools have15ms acquire/50ms statement/75ms request limits. No connection crosses external work, no participation writer pool or new lock/schema is used.

Existing verified participant and OIDC users only; XID/cookie/creation paths, unsupported inputs or resource failures hand back. Every request resolves its supplied capability directly. A single canonical reverse row supplies the filename; ambiguity hands back. The known warm reverse-cache difference after an owner adds a code is retained as a limitation of direct lookup. No participant or invite is created or updated.

A missing participant receives the source's header plus newline; an existing participant with no active invites receives the header without a newline. Populated downloads admit at most200 active, participant-owned invites ordered by id,64KiB output, and explicit TZ=UTC or Etc/UTC. Dates outside1970–9999 or other timezone environments hand back; empty downloads are timezone-independent. Nullable dates stay empty; comma/quote/newline CSV escaping, Unicode, the unquoted carriage-return case and the millisecond ISO filename are preserved.

The route originated in TypeScript after the server conversion. No pre-conversion JS handler exists; its origin and current helper path were checked. The raw recorder compares complete unchanged-Node HTTP bytes and all-off responses; no header/body normalization. DB tests cover membership, dates, escaping, readonly enforcement and independent service during a stalled CSV read. No rollout, Node or schema change is included.
