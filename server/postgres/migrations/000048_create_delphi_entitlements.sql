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
-- it. No existing table, column, index, constraint, function, trigger, rule or
-- grant changes, and this file creates no function, trigger or rule.
--
-- Compatibility: additive. No earlier release names the table.
--
-- Locks. The table is new, so the ACCESS EXCLUSIVE lock it is created under
-- is one nobody else can wait on. Its two foreign keys, both to public.users,
-- take SHARE ROW EXCLUSIVE on users until COMMIT (milliseconds: 3 ms median,
-- 6 ms at most, over 20 runs on PostgreSQL 17.11; no row is read or written).
-- While it is held, reads of users go on, and so do writes
-- to tables whose foreign keys point at users (their key-share row locks do
-- not conflict); writes to users itself (a new anonymous participant's
-- account, an account's first sign-in) wait for COMMIT. A transaction already
-- writing users makes this file wait at most lock_timeout (5 s), with those
-- writes queued behind it, and then fail with nothing changed; the deploy can
-- be retried.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.delphi_entitlements(
 uid integer PRIMARY KEY REFERENCES public.users(uid) ON DELETE CASCADE,
 granted_at bigint NOT NULL DEFAULT public.now_as_millis(),
 granted_by integer REFERENCES public.users(uid) ON DELETE SET NULL,
 source text NOT NULL CHECK(source IN ('auth0_role','site_admin'))
);
COMMIT;
