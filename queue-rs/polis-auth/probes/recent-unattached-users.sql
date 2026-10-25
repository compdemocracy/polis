-- Millisecond timestamps; include the lower boundary and exclude future rows.
SELECT count(*) AS recent_unattached_users
FROM users u
WHERE u.created >= (extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint - 86400000
  AND u.created <= (extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint
  AND NOT EXISTS (SELECT 1 FROM participants p WHERE p.uid = u.uid)
  AND NOT EXISTS (SELECT 1 FROM oidc_user_mappings m WHERE m.uid = u.uid);
