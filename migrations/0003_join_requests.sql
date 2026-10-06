-- Public "request to join" notes for an association.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this file, Execute.
-- Details are in the README section "Request to join".

CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE INDEX idx_join_requests_association ON join_requests (association_id, status, created_at);
