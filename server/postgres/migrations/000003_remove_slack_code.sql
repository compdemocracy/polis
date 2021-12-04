ALTER TABLE conversations DROP COLUMN is_slack CASCADE;

DROP TABLE slack_oauth_access_tokens CASCADE;
DROP TABLE slack_users CASCADE;
DROP TABLE slack_user_invites CASCADE;
DROP TABLE slack_bot_events CASCADE;
