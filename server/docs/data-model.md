# Polis Data Model

This document is an orientation to the core PostgreSQL data model — the tables a
developer touches when working on conversations, comments, votes, and participants. It
is not an exhaustive column-by-column reference; the **source of truth is always the SQL
in [`server/postgres/migrations/`](../postgres/migrations/)** (the `000000_initial.sql`
file plus the numbered migrations applied on top of it). The goal here is to make the
schema *legible*: how the pieces relate, and the handful of conventions that surprise
people.

If you just want to apply migrations, see [docs/migrations.md](../../docs/migrations.md).
For the *shape of the math output* (not the storage schema), see
[docs/pca.md](../../docs/pca.md).

---

## Keys and conventions you need up front

A few things are true almost everywhere, and knowing them removes most of the confusion:

- **`zid`** — conversation id. `SERIAL`, globally unique. Internal; never shown to users.
- **`tid`** — comment (statement) id. **Per-conversation**, assigned by the `tid_auto`
  trigger — so comment ids start at 0 in every conversation. The real key is `(zid, tid)`.
- **`pid`** — participant id. **Per-conversation**, assigned by the `pid_auto` trigger —
  likewise starts at 0 per conversation. The real key is `(zid, pid)`.
- **`uid`** — user (account) id. `SERIAL`, globally unique. A `uid` maps to a `pid` *within*
  a conversation via the `participants` table.
- **`zinvite`** — the public, opaque conversation identifier (the string in a conversation
  URL). It maps to the internal `zid` via the `zinvites` table. **Outside callers know the
  `zinvite`; the database works in `zid`.** Treat the `zinvite` as semi-public: it appears in
  voting URLs, but when auth/XID isn't enabled anyone holding it can vote, so don't circulate
  it beyond the intended voters. `zid` is the internal key; how sensitive it is depends on
  your threat model.
- **Timestamps are `BIGINT` epoch-milliseconds** (`created`, `modified`, …), defaulted via
  `now_as_millis()`. Use `to_timestamp(created / 1000.0)` to read one.
- **`-1` does NOT mean "no" / "negative".** Several columns use small signed integers as
  enums where `-1` is a *specific state*, not a sentinel — see the vote sign and `mod`
  columns below. Read the column comment in `000000_initial.sql` before assuming.

---

## The core: conversations → comments → votes

This is the participation loop. Everything else is identity, configuration, or computed
output around it.

### `conversations` (keyed by `zid`)

One row per conversation/poll. Holds the content (`topic`, `description`) and a large set
of configuration flags. The ones that matter most operationally:

- `is_active`, `is_public`, `is_draft` — lifecycle/visibility.
- `strict_moderation` — if true, new comments must be approved before others can vote on them.
- `write_type` — `1` shows the comment form, `0` hides it.
- **`vis_type`** — UI flag for whether the results visualization is shown. **`0` = off (the
  default), `1` = on.** This is a client-side render gate, *not* a server guarantee — the
  server does not withhold `GET /api/.../results/` based on it. A common "why don't I see
  results?" cause.
- `owner` → `users(uid)` — who created/owns it.
- Later migrations add:
  - `xid_required` — require an XID, the pseudonym mapping the authenticator's user ID to the
    polis participant; used for authenticated conversations.
  - `treevite_enabled` — `delphi`'s staggered "wave" invites (new/experimental).
  - `topics_enabled` — `delphi` embeddings-based topic analysis (new/experimental).

### `zinvites` (`zid` ↔ `zinvite`)

Maps the internal `zid` to one or more public `zinvite` strings (unique). A later
migration also adds a `uuid`. This is the indirection that lets the public id be opaque
and stable while internal joins use the integer `zid`.

### `comments` (keyed by `(zid, tid)`)

One row per statement participants vote on. `txt` is the statement; `uid`/`pid` is the
author. Key columns:

- **`mod`** — moderation state, a plain `INTEGER DEFAULT 0` (no DB-level CHECK, but used as an
  enum): `-1` = rejected, `0` = unmoderated, `1` = accepted.
- `active` — false hides the comment regardless of `mod`.
- `is_seed` — seeded by the moderator (vs. submitted by a participant).
- `is_meta` — a meta/notice comment, excluded from the math.
- `velocity` — a moderation/ranking weight used by the legacy Clojure comment-routing; the
  newer `delphi` routing may not use it. Treat as legacy-leaning.

`comments` has a foreign key on `(zid, pid)` into `participants`: a comment must be authored
by a participant that exists in that conversation. "Known" means only that a `participants`
row exists — it says nothing about *who* they are; identifying info exists only if the
organizer enabled auth/XID or demographic collection.

### `votes` and `votes_latest_unique` (keyed by `(zid, pid, tid)`)

Two tables, one concept, and the single most surprising part of the schema.

- **`votes` is append-only.** Every vote — including a participant *changing* their vote —
  inserts a new row. `created` is the epoch-millis timestamp; there is no `modified` column.
- **`votes_latest_unique` is the authoritative current vote** per `(zid, pid, tid)`. A
  `RULE` (`on_vote_insert_update_unique_table`) upserts this table on every insert into
  `votes`, so it always reflects the latest vote, with a `modified` timestamp. **Query this
  table for current state; query `votes` for history.**

The `vote` value itself:

```
vote SMALLINT   -- -1 = Agree, 1 = Disagree, 0 = Pass/Unsure
```

> ⚠️ **The raw sign is the opposite of the data export.** In these tables (and in the vote
> API) `-1` means **Agree**. The `participants-votes` CSV export *negates* every vote so
> that Agree = `+1`, Disagree = `-1` (see `get-corrected-conversation-votes` in
> [`math/src/polismath/darwin/export.clj`](../../math/src/polismath/darwin/export.clj)).
> So both are "correct" at different layers — but when you read the `votes` table directly,
> **`-1` is Agree.**

`weight_x_32767` is a separate priority/weight value stored as a fixed-point integer:
divide by 32767 to get a float in `[-1, 1]` (it is unrelated to the `vote` value).

### `participants` (keyed by `(zid, pid)`, also unique on `(zid, uid)`)

One row per (user, conversation): a `uid` that has joined conversation `zid`, with their
per-conversation `pid`. Tracks `vote_count`, `last_interaction`, subscription state, and a
`mod` field for the *participant* (`-1` hide-from-vis, `0` none, `1` acknowledge, `2` pin).
The `mod` column is a plain `INTEGER DEFAULT 0` (no DB-level CHECK).
`participants_extended` holds optional extras (referrer, parent_url, a permanent cookie).

---

## Identity: `users` and `xids`

- **`users` (keyed by `uid`)** — accounts. `email`, `hname`/`username`, and `is_owner`
  (can start conversations). Both registered owners and ephemeral participants are `users`.
- **`xids` (cross-identity)** — maps an **external identifier** (`xid`, supplied by an
  embedding site) to a `uid`, scoped to an `owner` (the account that owns the integration):
  `UNIQUE (owner, xid)`. Carries optional `x_name` / `x_email` / `x_profile_image_url`. This
  is how SSO/embedded deployments attach their own user identity to a Polis participant
  without Polis accounts. (`xid_whitelist` restricts which xids may participate when a
  conversation sets `xid_required`.)
- Invite/token tables sit alongside these: `zinvites` (above), `einvites`/`oinvites`/
  `suzinvites` (email/owner/single-use invites), `auth_tokens`, `pwreset_tokens`, and
  `oidc_user_mappings` (OIDC SSO).

---

## Computed output: the `math_*` tables

The **math** (Clojure) and **delphi** (Python) services poll the vote data, run PCA /
clustering, and write results back for the server and report clients to read. The schema
side is small:

> **Caveat:** this describes the Clojure `math` service's output in Postgres. The newer
> `delphi` (Python) service computes considerably more and — by a deliberate architecture
> decision — stores most of it in **DynamoDB, not Postgres**. Some delphi code still reads
> parts of the Clojure `math` blob, but Postgres is no longer the complete results picture.

- **`math_main`** — the headline result: `data jsonb` holds the PCA/clustering object
  (consensus, opinion groups, comment stats — the structure documented in
  [docs/pca.md](../../docs/pca.md)), keyed by `(zid, math_env)`, with `math_tick` /
  `last_vote_timestamp` for cache-invalidation.
- Supporting tables: `math_profile`, `math_ptptstats`, `math_bidtopid`, `math_ticks`,
  `math_cache`, `math_exportstatus`, and `math_report_correlationmatrix`.
- **`reports` / `report_comment_selections`** — saved/curated report views over a conversation.

The server never computes these; it only reads them. If you don't see results in the UI it
usually means math hasn't produced output yet (or, client-side, `vis_type = 0` — above).

---

## Everything else, at a glance

After all migrations are applied, the schema has **61 base tables**. Beyond the core above,
they group as follows. Most need no day-to-day attention.

| Group | Tables | Notes |
|---|---|---|
| Multi-tenant / SaaS | `inviters`, `contexts` | The hosted-product account layer. Note: classic Polis `orgs` / `oadmins` / `omemberships` / `permissions` tables are **not present** in this fork's schema. |
| Participant metadata / surveys | `participant_metadata_questions` / `_answers` / `_choices`, `demographic_data`, `participant_locations` | Optional per-participant survey/demographic data. |
| Features | `treevite_waves` / `treevite_invites` / `treevite_login_codes` (gated entry), `topic_agenda_selections`, `byod_import_jobs`, `notification_tasks`, `worker_tasks`, `event_ptpt_no_more_comments`, `crowd_mod` | Newer or peripheral features. |
| Translations | `comment_translations`, `conversation_translations` | Cached machine translations. |
| Legacy social login | `facebook_users`, `facebook_friends`, `twitter_users`, `social_settings` | Social-login tables. No references in `server/src`, `math`, or `delphi` — dead in this fork. |
| Other dormant tables | `courses`, `beta`, `contributer_agreement_signatures`, and the historically obfuscated-name auth tables `apikeysndvweifu` (api keys) and `jianiuevyew` (password hashes) | No references found in `server/src`, `math`, or `delphi` (this fork authenticates via OIDC, so the password-hash table is unused). Retained for migration history. |

> ⚠️ **Not "legacy" — still referenced by live server code.** Several tables that look
> vestigial are actually written/read by current `server/src` SQL, so do not assume they are
> safe to drop: `stars`, `upvotes`, `trashes` (comment moderation actions), `page_ids`
> (embed / implicit-conversation), `metrics` (client metrics insert), `email_validations`,
> and `site_domain_whitelist` (embed domain allow-list). (There is **no table named
> `permanent`**. Live permanent-cookie auth reads/writes
> **`participants_extended.permanent_cookie`** (`server/src/participant.ts`,
> `getParticipantByPermanentCookie`) — *not* the `permanentCookieZidJoins` table, which
> appears only in the schema (`000000_initial.sql`) with no `server/src`, `math`, or `delphi`
> references, i.e. legacy/unused.)

A handful of tables (Slack/Stripe/Canvas/LTI integrations, the waiting list,
geolocation) were dropped by migrations 000004 / 000005 / 000007 and no longer exist.

---

## Where to look next

- **Exact columns / constraints:** `server/postgres/migrations/000000_initial.sql`, then
  the numbered migrations for changes since.
- **Applying migrations:** [docs/migrations.md](../../docs/migrations.md).
- **The math result structure:** [docs/pca.md](../../docs/pca.md).
- **Auth and identity internals:** [server/docs/authentication.md](./authentication.md).
