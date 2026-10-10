-- Catalog postconditions only; this file never replays migration DDL.
SELECT to_regclass('public.geolocation_cache') IS NULL
 AND pg_temp.absent_column('participants_extended','country_code_iso')
 AND pg_temp.absent_column('participants_extended','encrypted_maxmind_response_city')
 AND pg_temp.absent_column('participants_extended','ip_address')
 AND pg_temp.absent_column('participants_extended','latitude')
 AND pg_temp.absent_column('participants_extended','location')
 AND pg_temp.absent_column('participants_extended','longitude')
 AND pg_temp.absent_column('participants_extended','x_forwarded_for');
