-- Lets the board mark a message thread reviewed without sending a reply.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0006_notice_attachments.sql. Details are in the README under Mark a message reviewed.
-- If the console says a column already exists, this file was already applied. Stop.

ALTER TABLE messages ADD COLUMN reviewed_at TEXT;
