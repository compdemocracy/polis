-- Catalog postconditions only; this file never replays migration DDL.
SELECT to_regclass('public.waitinglist') IS NULL;
