-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col_exact('comments','original_id','uuid',false);
