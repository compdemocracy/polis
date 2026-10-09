-- Catalog postconditions only; this file never replays migration DDL.
SELECT to_regclass('public.password_reset_tokens') IS NULL
 AND pg_temp.col('pwreset_tokens','token','character varying(250)')
 AND pg_temp.absent_column('pwreset_tokens','pwresettoken');
