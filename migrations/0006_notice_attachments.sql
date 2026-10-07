-- Optional file on a portal notice.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0005_admin_improvements.sql. Details are in the README under Portal notice files.
-- If the console says a column already exists, this file was already applied. Stop.

ALTER TABLE notifications ADD COLUMN attachment_filename TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN attachment_content_type TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN attachment_r2_key TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN attachment_byte_size INTEGER NOT NULL DEFAULT 0;
