-- Disposable synthetic DB only. Production 000021 has no math-table triggers.
-- A latch is observed through pg_locks on the actual publication backend.
CREATE FUNCTION p027_bridge_pause() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE stage text:=lower(TG_WHEN)||'_'||TG_ARGV[0];
BEGIN
 IF current_setting('p027.bridge_stage',true)=stage THEN
  PERFORM set_config('p027.bridge_stage','',true);
  PERFORM pg_advisory_xact_lock(21421,current_setting('p027.bridge_key')::integer);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER p027_before BEFORE INSERT OR UPDATE ON math_ticks FOR EACH ROW EXECUTE FUNCTION p027_bridge_pause('ticks');
CREATE TRIGGER p027_after AFTER INSERT OR UPDATE ON math_ticks FOR EACH ROW EXECUTE FUNCTION p027_bridge_pause('ticks');
CREATE TRIGGER p027_before BEFORE INSERT OR UPDATE ON math_bidtopid FOR EACH ROW EXECUTE FUNCTION p027_bridge_pause('bidtopid');
CREATE TRIGGER p027_after AFTER INSERT OR UPDATE ON math_bidtopid FOR EACH ROW EXECUTE FUNCTION p027_bridge_pause('bidtopid');
CREATE TRIGGER p027_before BEFORE INSERT OR UPDATE ON math_ptptstats FOR EACH ROW EXECUTE FUNCTION p027_bridge_pause('ptptstats');
CREATE TRIGGER p027_after AFTER INSERT OR UPDATE ON math_ptptstats FOR EACH ROW EXECUTE FUNCTION p027_bridge_pause('ptptstats');
CREATE TRIGGER p027_before BEFORE INSERT OR UPDATE ON math_main FOR EACH ROW EXECUTE FUNCTION p027_bridge_pause('main');
CREATE TRIGGER p027_after AFTER INSERT OR UPDATE ON math_main FOR EACH ROW EXECUTE FUNCTION p027_bridge_pause('main');
