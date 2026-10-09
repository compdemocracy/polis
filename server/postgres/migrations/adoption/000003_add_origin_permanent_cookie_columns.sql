-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col_exact('participants_extended','permanent_cookie','character varying(32)',false)
 AND pg_temp.col_exact('participants_extended','origin','character varying(9999)',false);
