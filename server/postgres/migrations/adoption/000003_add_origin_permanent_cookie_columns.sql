-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col('participants_extended','permanent_cookie','character varying(32)')
 AND pg_temp.col('participants_extended','origin','character varying(9999)');
