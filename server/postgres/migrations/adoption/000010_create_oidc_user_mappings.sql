-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.col('oidc_user_mappings','oidc_sub','character varying(255)',true)
 AND pg_temp.col('oidc_user_mappings','uid','integer',true)
 AND pg_temp.col('oidc_user_mappings','created','bigint',false,'now_as_millis()')
 AND pg_temp.con('oidc_user_mappings','PRIMARY KEY (oidc_sub)')
 AND pg_temp.con('oidc_user_mappings','UNIQUE (uid)')
 AND pg_temp.con('oidc_user_mappings','FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE')
 AND pg_temp.idx('idx_oidc_mappings_uid','CREATE INDEX idx_oidc_mappings_uid ON public.oidc_user_mappings USING btree (uid)');
