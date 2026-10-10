-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col('suzinvites','xid','text',true);
