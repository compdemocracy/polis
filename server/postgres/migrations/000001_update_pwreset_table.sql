ALTER TABLE password_reset_tokens RENAME COLUMN pwresettoken TO token;
ALTER TABLE password_reset_tokens RENAME TO pwreset_tokens;
