-- Neighborhood code and public address for each association.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0016_seed_seaside_demo.sql. Deploy does not apply D1 migrations.
-- Tang-O-Mar code is 850 and its public address is tangomar.
-- The read-only demo code is 100 and its public address is seaside.
-- If the demo row is not in the database yet, apply 0016 first, then run the demo UPDATE at the bottom again.
-- Safe to paste again only when the columns are not already there. If the console says a column already exists, stop.

ALTER TABLE associations ADD COLUMN neighborhood_code TEXT;
ALTER TABLE associations ADD COLUMN vanity_slug TEXT;

CREATE UNIQUE INDEX associations_neighborhood_code_uid ON associations (neighborhood_code);
CREATE UNIQUE INDEX associations_vanity_slug_uid ON associations (vanity_slug);

UPDATE associations
SET neighborhood_code = '850', vanity_slug = 'tangomar'
WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar';

UPDATE associations
SET neighborhood_code = '100', vanity_slug = 'seaside'
WHERE slug = 'seaside-demo' OR id = 'assoc_seaside_demo';
