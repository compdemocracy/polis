-- Count memberships in XID-required conversations; exclude the owner itself.
SELECT count(*) AS participants_missing_owner_xids
FROM conversations c
JOIN participants p ON p.zid = c.zid
WHERE (c.xid_required OR c.use_xid_whitelist)
  AND p.uid <> c.owner
  AND NOT EXISTS (SELECT 1 FROM xids x WHERE x.uid = p.uid AND x.owner = c.owner);
