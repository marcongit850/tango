-- Allow a join request to be marked approved.
-- SQLite cannot change a CHECK constraint in place, so this rebuilds the table.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this file, Execute.
-- Run this once, after migrations/0003_join_requests.sql. Details are in the README under Request to join.

CREATE TABLE join_requests_next (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'approved')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

INSERT INTO join_requests_next (id, association_id, name, email, address, note, status, created_at)
SELECT id, association_id, name, email, address, note, status, created_at
FROM join_requests;

DROP TABLE join_requests;

ALTER TABLE join_requests_next RENAME TO join_requests;

CREATE INDEX idx_join_requests_association ON join_requests (association_id, status, created_at);
