-- One master admin per association. That membership cannot be deleted, and edit access stays on.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0008_document_folders.sql. Details are in the README under Master admin.
-- If marc@whpinc.com already has a membership, that membership becomes the master and edit access is turned on.
-- The membership is set active so that person can sign in. Their role is left as it is.
-- If that login is not a member, the earliest active person who already has edit access in that association becomes the master.
-- On the demo roster that person is Jordan Lee (jordan.lee@example.com), because marc@whpinc.com is not in the seed.
-- Each association is chosen on its own. A master in one neighborhood is not the master of another.
-- If the console says a column already exists, this file was already applied. Stop.

ALTER TABLE memberships ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0
  CHECK (
    is_master IN (0, 1)
    AND (is_master = 0 OR (is_admin = 1 AND status != 'inactive'))
  );

UPDATE memberships
SET is_master = 1, is_admin = 1, status = 'active'
WHERE user_id IN (SELECT id FROM users WHERE email = 'marc@whpinc.com');

UPDATE memberships
SET is_master = 1, is_admin = 1
WHERE id IN (
  SELECT m.id
  FROM memberships m
  WHERE m.status = 'active'
    AND (m.role_id = 'officer' OR m.is_admin = 1)
    AND NOT EXISTS (
      SELECT 1 FROM memberships locked
      WHERE locked.association_id = m.association_id
        AND locked.is_master = 1
    )
    AND m.id = (
      SELECT m2.id
      FROM memberships m2
      WHERE m2.association_id = m.association_id
        AND m2.status = 'active'
        AND (m2.role_id = 'officer' OR m2.is_admin = 1)
      ORDER BY m2.created_at, m2.id
      LIMIT 1
    )
);

CREATE UNIQUE INDEX idx_memberships_one_master
  ON memberships (association_id)
  WHERE is_master = 1;

CREATE TRIGGER memberships_block_master_delete
BEFORE DELETE ON memberships
FOR EACH ROW
WHEN OLD.is_master = 1
BEGIN
  SELECT RAISE(ABORT, 'The master admin cannot be deleted.');
END;
