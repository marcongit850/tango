-- Optional files on a message an owner sends to the board.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0011_lot_details.sql. Details are in the README under Message files.
-- CREATE TABLE IF NOT EXISTS is safe to run again.

CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS message_attachments_message_idx
  ON message_attachments (association_id, message_id, position);
