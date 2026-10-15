-- Per-association fee schedule for dues.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0017_neighborhood_codes.sql. Deploy does not apply D1 migrations.
-- This file adds tables and columns. It does not delete or rewrite invoices, payments, or assessments.
-- Tang-O-Mar starts with first improved $625, additional improved $315, vacant $220, and a Beach box add-on at $150.
-- Those amounts are per assessment period. Admins can change them. Other associations start with no schedule until an admin saves one.
-- If the console says a column already exists, this file was already applied. Stop. Do not paste it again.

ALTER TABLE assessments ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'flat';
ALTER TABLE invoices ADD COLUMN billed_user_id TEXT;

CREATE TABLE fee_schedules (
  association_id TEXT PRIMARY KEY,
  first_improved_cents INTEGER NOT NULL CHECK (first_improved_cents >= 0),
  additional_improved_cents INTEGER NOT NULL CHECK (additional_improved_cents >= 0),
  vacant_cents INTEGER NOT NULL CHECK (vacant_cents >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE TABLE fee_addon_types (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE TABLE owner_addons (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  addon_type_id TEXT NOT NULL,
  property_id TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (addon_type_id) REFERENCES fee_addon_types (id),
  FOREIGN KEY (property_id) REFERENCES properties (id)
);

CREATE TABLE owner_primary_lots (
  association_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (association_id, user_id),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (property_id) REFERENCES properties (id)
);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  property_id TEXT,
  near_property_id TEXT,
  addon_type_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('first_improved', 'additional_improved', 'vacant', 'addon')),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_cents INTEGER NOT NULL CHECK (unit_amount_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (invoice_id) REFERENCES invoices (id),
  FOREIGN KEY (property_id) REFERENCES properties (id),
  FOREIGN KEY (near_property_id) REFERENCES properties (id),
  FOREIGN KEY (addon_type_id) REFERENCES fee_addon_types (id)
);

CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX invoice_lines_property ON invoice_lines (association_id, property_id);
CREATE INDEX owner_addons_user ON owner_addons (association_id, user_id);

INSERT INTO fee_schedules (
  association_id, first_improved_cents, additional_improved_cents, vacant_cents, updated_at
)
SELECT id, 62500, 31500, 22000, '2026-10-15T00:00:00Z'
FROM associations
WHERE id = 'assoc_tango_mar' OR slug = 'tango-mar';

INSERT INTO fee_addon_types (id, association_id, name, amount_cents, active, created_at)
SELECT 'addon_tango_beach_box', id, 'Beach box', 15000, 1, '2026-10-15T00:00:00Z'
FROM associations
WHERE id = 'assoc_tango_mar' OR slug = 'tango-mar';
