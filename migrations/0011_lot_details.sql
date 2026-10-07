-- House name, mailing address, and admin-only notes on each lot.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0010_document_date.sql. Details are in the README under Lot details.
-- If the console says a column already exists, this file was already applied. Stop. Do not paste it again.

ALTER TABLE properties ADD COLUMN house_name TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN mailing_street TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN mailing_city TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN mailing_state TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN mailing_postal_code TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN admin_notes TEXT NOT NULL DEFAULT '';
