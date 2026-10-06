-- Admin improvements for Tango Mar.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0004_join_request_approved.sql. Details are in the README under Admin improvements.
-- If the console says a column already exists, or join_requests_next already exists, stop and follow the README note for a partial paste.

-- Admin flag. People who already administer the association (board or officer) keep that access.
-- Officers become board members. Homeowners stay homeowners and do not get admin.
ALTER TABLE memberships ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1));

UPDATE memberships SET is_admin = 1 WHERE role_id IN ('board', 'officer');

UPDATE memberships SET role_id = 'board' WHERE role_id = 'officer';

UPDATE roles
SET label = 'Board member',
    description = 'Board member. Admin tools are available only when the admin flag is on.'
WHERE id = 'board';

UPDATE roles
SET description = 'Resident owner. Sees only their own lots, balances, and messages.'
WHERE id = 'homeowner';

DELETE FROM roles WHERE id = 'officer';

-- Lot type. Existing lots start as improved. Change unimproved lots in Admin, Owners and lots.
ALTER TABLE properties ADD COLUMN lot_type TEXT NOT NULL DEFAULT 'improved' CHECK (lot_type IN ('improved', 'unimproved'));

-- Assessment open date and which lot type it applies to. NULL lot_type means every lot (older rows).
ALTER TABLE assessments ADD COLUMN opens_on TEXT;
ALTER TABLE assessments ADD COLUMN lot_type TEXT CHECK (lot_type IS NULL OR lot_type IN ('improved', 'unimproved'));

-- Join requests can be declined. Approved, reviewed, and pending rows are kept.
CREATE TABLE join_requests_next (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'approved', 'declined')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

INSERT INTO join_requests_next (id, association_id, name, email, address, note, status, created_at)
SELECT id, association_id, name, email, address, note, status, created_at
FROM join_requests;

DROP TABLE join_requests;

ALTER TABLE join_requests_next RENAME TO join_requests;

CREATE INDEX idx_join_requests_association ON join_requests (association_id, status, created_at);

-- Seed FAQ mentioned officers. Refresh that sentence when it is still the original text.
UPDATE faqs
SET answer = 'You can see the lots linked to your login. Other residents cannot. People with admin access can see ledgers for this association only, not for any other association on this deployment.'
WHERE id = 'faq_balance'
  AND answer = 'You can see the lots linked to your login. Other residents cannot. Board members and officers can see ledgers for Tango Mar only, not for any other association on this deployment.';
