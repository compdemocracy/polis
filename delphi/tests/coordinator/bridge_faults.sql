-- Disposable public-fixture DB only. Production 000021 has no math-table triggers.
-- A latch is observed through pg_locks on the actual publication backend.
CREATE FUNCTION p027_bridge_pause() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE stage text:=lower(TG_WHEN)||'_'||TG_ARGV[0]; lock_budget text;
BEGIN
 IF current_setting('p027.bridge_stage',true)=stage THEN
  PERFORM set_config('p027.bridge_stage','',true);
  -- Only the deliberate test latch gets the test statement's bounded budget.
  -- Restore the normal budget before any subsequent real publication lock.
  lock_budget:=current_setting('lock_timeout');
  PERFORM set_config('lock_timeout','120s',true);
  PERFORM pg_advisory_xact_lock(21421,current_setting('p027.bridge_key')::integer);
  PERFORM set_config('lock_timeout',lock_budget,true);
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
