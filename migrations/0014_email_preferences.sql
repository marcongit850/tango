-- Email announcement preference and an append-only electronic notice consent log.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0013_co_owner_request.sql. Details are in the README under Email preferences.
-- Do not UPDATE or DELETE rows in electronic_notice_consent. Current status is the latest row.
-- There is no foreign key to users, so deleting a login does not remove the log.
-- If the console says a column or table already exists, this file was already applied. Stop. Do not paste it again.

ALTER TABLE users ADD COLUMN email_announcements INTEGER NOT NULL DEFAULT 1 CHECK (email_announcements IN (0, 1));

CREATE TABLE electronic_notice_consent (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  lots TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
  reason TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE INDEX idx_electronic_notice_consent_user
  ON electronic_notice_consent (association_id, user_id, created_at);
