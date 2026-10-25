-- A legacy NULL zid does not establish a matching (zid, uid) membership.
SELECT count(*) AS xids_missing_participant_id
FROM xids x
WHERE x.pid IS NULL
  AND EXISTS (SELECT 1 FROM participants p WHERE p.zid = x.zid AND p.uid = x.uid);
