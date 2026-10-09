-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col('reports','mod_level','smallint',true,'''-2''::integer');
