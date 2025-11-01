# Conversation Management Interface Updates

[x] Allow superadmins to view all conversations (paginated)
[x] Allow superadmins to switch between "my conversations" (current default) and "all conversations" view
[x] "All Conversations" view should show a table with the following columns: topic, participant count, comment count, updated date, creation date, owner.email, is_active
[x] Allow superadmins to sort all-conversations list by updated date, creation date, participant count, comment count
[x] Allow superadmins to filter all-conversations list by owner.email, is_active, recently updated (last 30 days), recently created (last 30 days), comment count >= 100
[ ] Create a new client-admin conversation view "Participant Management", visible to users for whom `hasDelphiEnabled` is true
[ ] Participant Management - if conversation.use_xid_whitelist is true, show a table of the XID Whitelist (postgres xid_whitelist table, keys by owner uid)
[ ] XID Whitelist table has only two columns: xid and participant (pid or "unused" if no pid is associated with the xid). See `sendParticipantXidsSummary` for very similar data in the server (server/src/report.ts)
[ ] If conversation.use_xid_whitelist is false, show a similar table of [xid | participant] anyway, but without referencing the xid_whitelist table (ie any used xids will show up here)
[ ] Participant Management - allow admin to upload a new xid whitelist file (csv with one xid per line), see `handle_POST_xidWhitelist` in server/src/routes/math.ts
[ ] Participant Management - use pagination for the XID table (or XID Whitelist table)
[ ] Participant Management - allow admin to toggle the use_xid_whitelist flag for the conversation
