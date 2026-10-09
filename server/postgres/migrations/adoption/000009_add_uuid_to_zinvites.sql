-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col_exact('zinvites','uuid','uuid',false);
