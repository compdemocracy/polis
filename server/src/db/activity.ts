/** SQL projections of activity; the retained column is the metadata/import clock.
 * Only response readers use these expressions. Authorization/configuration reads
 * keep their cheap row lookup. No vote value is interpreted by these counts.
 */
export function conversationModifiedSql(alias: string): string {
  return `CASE WHEN ${alias}.modified IS NULL THEN NULL ELSE GREATEST(${alias}.modified,
    (SELECT MAX(v.created) FROM votes v WHERE v.zid = ${alias}.zid),
    (SELECT MAX(cm.created) FROM comments cm WHERE cm.zid = ${alias}.zid),
    (SELECT MAX(cm.modified) FROM comments cm WHERE cm.zid = ${alias}.zid)) END`;
}

// COUNT is cast to the existing integer wire type, including zero and revotes.
export function participantVoteCountSql(alias: string): string {
  return `(SELECT CASE WHEN COUNT(*) = 0 AND ${alias}.vote_count IS NULL THEN NULL ELSE COUNT(*)::integer END FROM votes v
    WHERE v.zid = ${alias}.zid AND v.pid = ${alias}.pid)`;
}
