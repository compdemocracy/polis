DROP TABLE IF EXISTS geolocation_cache;

ALTER TABLE participants_extended DROP COLUMN IF EXISTS country_code_iso;
ALTER TABLE participants_extended DROP COLUMN IF EXISTS encrypted_maxmind_response_city;
ALTER TABLE participants_extended DROP COLUMN IF EXISTS ip_address;
ALTER TABLE participants_extended DROP COLUMN IF EXISTS latitude;
ALTER TABLE participants_extended DROP COLUMN IF EXISTS location;
ALTER TABLE participants_extended DROP COLUMN IF EXISTS longitude;
ALTER TABLE participants_extended DROP COLUMN IF EXISTS x_forwarded_for;
