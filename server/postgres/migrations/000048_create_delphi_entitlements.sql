-- 000048_create_delphi_entitlements.sql
--
-- One new table: the accounts that may use Polis 2 (start a Delphi run, a
-- narrative batch, a collective statement or the legacy narrative, or import
-- votes by CSV), one row per account. A row records when the permission was
-- granted (milliseconds, as every other Polis timestamp), which account
-- granted it, and where it came from: 'auth0_role' (carried over from the
-- identity provider's role) or 'site_admin' (granted by a site
-- administrator). No row: no permission recorded here.
--
-- Deleting an account deletes its row. Deleting the account that granted a
-- row keeps the row and clears granted_by.
--
-- Read only when POLIS_DELPHI_ENTITLEMENT is claim_or_db or db
-- (docs/configuration.md); under the default, claim, the server never reads
-- it. No existing table, column, index, constraint, function, rule or grant
-- changes, and this file creates no function, trigger or rule of its own (the
-- two foreign keys add PostgreSQL's internal referential triggers).
--
-- Compatibility: additive. No earlier release names the table.
--
-- Locks. The table is new, so the ACCESS EXCLUSIVE lock it is created under
-- is one nobody else can wait on. Its two foreign keys, both to public.users,
-- take SHARE ROW EXCLUSIVE on users until COMMIT (milliseconds: 5 ms median,
-- 9 ms at most, over 40 runs on PostgreSQL 17.11; no row is read or written).
-- While it is held, reads of users go on, and so do writes to tables whose
-- foreign keys point at users (their key-share row locks do not conflict);
-- writes to users itself (a new anonymous participant's account, an account's
-- first sign-in) wait for COMMIT.
--
-- Its lock_timeout is 200 ms, not the runner's 5 s. While another session
-- holds a conflicting lock on users (a transaction that wrote users, or a
-- vacuum of it), this file waits, and every new writer of users queues behind
-- it. A first sign-in gives up on a lock after 500 ms (the server's bounds in
-- server/src/db/pg-query.ts) and is answered HTTP 500, and that request can be
-- a vote or a comment; at 200 ms nobody waits longer and nothing is refused.
-- On such a busy instant this file fails with nothing changed (no table, no
-- history row); the deploy stops before any service is replaced and is rerun.
BEGIN;
SET LOCAL lock_timeout='200ms';
CREATE TABLE public.delphi_entitlements(
 uid integer PRIMARY KEY REFERENCES public.users(uid) ON DELETE CASCADE,
 granted_at bigint NOT NULL DEFAULT public.now_as_millis(),
 granted_by integer REFERENCES public.users(uid) ON DELETE SET NULL,
 source text NOT NULL CHECK(source IN ('auth0_role','site_admin'))
);
COMMIT;
