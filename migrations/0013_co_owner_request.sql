-- An owner request to add another person to a lot they already own.
-- A blank property_id is a normal request to join. Approval of a filled property_id
-- adds that person to the lot instead of leaving an occupied lot alone.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0012_message_attachments.sql. Details are in the README under My profile.
-- If the console says a column already exists, this file was already applied. Stop. Do not paste it again.

ALTER TABLE join_requests ADD COLUMN property_id TEXT NOT NULL DEFAULT '';
