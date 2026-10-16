-- Correct the sample annual meeting clock time on the read-only demo.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0016_seed_seaside_demo.sql. Deploy does not apply D1 migrations.
-- November 12, 2026 is Central Standard Time (UTC-6). 6:00 p.m. Central is 2026-11-13T00:00:00Z.
-- The first seed used a daylight-time offset, so the calendar showed 5:00 p.m. CST.
-- This updates only event_demo_meeting. It does not read or update Tang-O-Mar rows.
-- Safe to paste again.

UPDATE events
SET starts_at = '2026-11-13T00:00:00Z',
    ends_at = '2026-11-13T01:30:00Z'
WHERE id = 'event_demo_meeting'
  AND association_id = 'assoc_seaside_demo';
