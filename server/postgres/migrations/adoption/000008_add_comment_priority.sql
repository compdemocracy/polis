-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col_exact('conversations','importance_enabled','boolean',true,'false')
 AND pg_temp.col_exact('votes','high_priority','boolean',true,'false');
