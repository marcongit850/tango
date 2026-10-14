# Tango Mar owner portal: architecture

Last checked against the code and Cloudflare on Oct 14, 2026.

## What it does

The Tango Mar POA owner portal. Owners sign in with an email magic link to see balances, documents, notices, and messages. The board manages lots, owners, assessments, documents, and notices. There is also a public estoppel request page. One deployment can host many associations, each with its own data.

## Domains and Worker

- Worker: `tango`
- Custom domains (attached in the Cloudflare dashboard): `mytangomar.com`, `www.mytangomar.com`
- Zone settings on mytangomar.com: Always Use HTTPS on, minimum TLS 1.2, SSL mode Full, HSTS max age 15552000 (no subdomains, no preload).

## Data and images

- Database: D1 `tango` (id `d3f6cfd2-cae0-42ef-843f-b5465efebd2b`), binding `DB`. Schema is in `migrations/` (0001 to 0016 so far). `0016_seed_seaside_demo.sql` adds the public demo association only. It does not read or update Tang-O-Mar rows.
- Document files: R2 bucket `tango-documents`, binding `DOCUMENTS`. D1 stores version metadata and the object key.
- Logo, images, video, and small browser scripts: `public/`, served as static assets (matching URLs are served before the Worker runs).
- Email: Resend (`https://api.resend.com/emails`).
- No KV.

## Secrets and env vars (names only)

- Secret: `RESEND_API_KEY`
- Vars in `wrangler.jsonc`: `APP_ENV` (`production`), `EMAIL_FROM` (`Tang-O-Mar <donotreply@mytangomar.com>`)
- Local only: `.dev.vars` (gitignored, see `.dev.vars.example`).

## Cron and scheduled jobs

- `15 6 * * *` (06:15 UTC, 12:15 AM CST or 1:15 AM CDT), set in `wrangler.jsonc`. `scheduled()` in `src/index.ts` runs `runDueAssessmentInvoices`, which creates invoices for assessments whose open date has arrived and catches up a missed day. The job skips association id `assoc_seaside_demo`, so the sample ledger does not change.

## How it deploys

- Cloudflare Workers Builds, auto deploy on merge to `main`. Repo `marcongit850/tango`, Worker tag `4813217a722544629cf506ff7f6761ac`, trigger `07af400f-a3e6-4aad-913c-6bc45ce832dc`, build command empty, deploy command `npx wrangler deploy`, root `/`.
- If a merge does not deploy: `POST /accounts/f1c59948520f1ec39473238b621c7e24/builds/triggers/07af400f-a3e6-4aad-913c-6bc45ce832dc/builds` with body `{"branch": "main", "commit_hash": "<full 40 character sha>"}`. Check builds with `GET /accounts/f1c59948520f1ec39473238b621c7e24/builds/workers/4813217a722544629cf506ff7f6761ac/builds?per_page=2` and match `commit_hash`.

## Public read-only demo

Anyone can open a fictional association from the public home page without a magic link. The link is "Try the demo". The same resident and admin routes render it.

- Slug `seaside-demo`, id `assoc_seaside_demo`, display name Seaside Demo HOA. People, lots, documents, announcements, dues, notices, and messages are seeded by `migrations/0016_seed_seaside_demo.sql`. That file must be applied by hand before the pages have data. Deploy does not apply it.
- Cookie `tango_demo` is `owner` or `admin`. It is not a row in `sessions`. `/demo` and `/demo/owner` set `owner` and open the sample dashboard. `/demo/admin` sets `admin` and opens admin. `/demo/leave` clears the cookie.
- On `/a/seaside-demo`, the Worker ignores `tango_session` and loads only the seeded persona for that association. Riley Coast is the owner. Quinn Harbor is the board admin. A real Tang-O-Mar login is not used on these pages.
- The demo cookie, and a session whose user id is one of the seeded demo people, does not authenticate `/a/tango-mar` or any other association. Login will not email those addresses or create a session for them.
- POST, PUT, PATCH, and DELETE under `/a/seaside-demo` stop in middleware, before a route handler runs. The visitor is sent back with "Demo only, changes are not saved". Those requests do not write D1, do not upload files, and do not send email.
- Sample covenant, budget, and minutes files are static text in `src/lib/demo.ts`. Opening them does not read or write Tang-O-Mar objects in R2, and it does not run the Tang-O-Mar seed-file writer.
- Demo pages show the banner "Demo site, sample data, read only", with links to view as Owner or as Board admin.

## Known gotchas

- D1 migrations are NOT applied by deploy. Each new `migrations/00NN_*.sql` is applied by hand (paste into the D1 console for database `tango`, or `npm run db:migrate:remote`) before the PR that needs it is merged. `migrations/0016_seed_seaside_demo.sql` is required for the public demo. Until it is applied, `/demo` says the demo is not ready and does not show Tang-O-Mar data.
- The cron list in `wrangler.jsonc` replaces any cron added in the dashboard on every deploy. Change schedules in the file, not the dashboard.
- Estoppel requests go to `ESTOPPEL_INBOX` in `src/lib/estoppel.ts` (marc@whpinc.com for now, to be changed later). The page links Florida Statute 720.30851.
- Demo requests go to `DEMO_INBOX` in `src/lib/demo-request.ts` (marc@whpinc.com).
- The estoppel rate limit (5 per IP per 10 minutes) lives in Worker memory, so a restart clears it.
- `EMAIL_FROM` must use a domain verified in Resend (mytangomar.com). Without `RESEND_API_KEY`, no mail goes out and production does not print magic links.
- Sample covenants and budget files are written into R2 the first time someone opens Documents. Replace them by uploading new versions.
- Uploads are limited to PDF, text, JPEG, PNG, WebP, and Word, up to 8 MB.

## Standing rule

Any PR that changes architecture (new secret, cron, storage, binding, or deploy change) must update this file in the same PR.
