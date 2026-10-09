-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col('conversations','importance_enabled','boolean',true,'false')
 AND pg_temp.col('votes','high_priority','boolean',true,'false');
