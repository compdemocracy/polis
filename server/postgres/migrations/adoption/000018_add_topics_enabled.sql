-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col('conversations','topics_enabled','boolean',true,'false');
