# Tango Mar owner portal: architecture

Last checked against the code and Cloudflare on Oct 14, 2026.

## What it does

The Tango Mar POA owner portal. Owners sign in with an email magic link to see balances, documents, notices, and messages. The board manages lots, owners, assessments, documents, and notices. There is also a public estoppel request page. One deployment can host many associations, each with its own data.

## Domains and Worker

- Worker: `tango` (one Worker, not a second app)
- Cloudflare account: `f1c59948520f1ec39473238b621c7e24`
- Product host: `myhoadashboard.com` and `www.myhoadashboard.com`. `/` is the MyHOADashboard marketing page. A neighborhood code sends the browser to `/<vanity_slug>`, which is that association's public landing and login.
- Tang-O-Mar public address: `/tangomar` (vanity slug). The older path `/a/tango-mar/...` still works. Login, dashboard, documents, and the other association routes under `/tangomar/...` use those same handlers.
- Legacy host: `mytangomar.com` and `www.mytangomar.com`. `LEGACY_HOST_REDIRECT` is `1`, so each request 301s to the matching `https://myhoadashboard.com/tangomar...` URL and keeps the path and query (magic links, email confirm links, and document links).
- Custom domains in `wrangler.jsonc` (all four must stay in that file): `myhoadashboard.com`, `www.myhoadashboard.com`, `mytangomar.com`, and `www.mytangomar.com`. Deploy replaces the Worker route list, so a domain attached only in the dashboard is removed.
- Zone settings on mytangomar.com: Always Use HTTPS on, minimum TLS 1.2, SSL mode Full, HSTS max age 15552000 (no subdomains, no preload).

## MyHOADashboard

- Marketing page on the product host only. Localhost still opens the Tang-O-Mar home at `/`. `mytangomar.com` redirects to `/tangomar`.
- Neighborhood code form posts to `/neighborhood`. Tang-O-Mar's code is `850`. The demo code is `100`. A bad code shows an error. Eight lookups per IP in ten minutes, kept in Worker memory.
- Contact opens the form on the page. The Contact control and the footer Contact link both use `#contact`. The inbox address is not shown on the page. Sending uses the `RESEND_API_KEY` secret.
- Product favicon and apple touch icon live in `public/brand/`. Tang-O-Mar pages keep `public/favicon.ico`, `public/favicon.png`, and `public/apple-touch-icon.png`. Other associations use the product icons.
- Session cookie `tango_session` is host-only (`Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS). It is not pinned to mytangomar.com, so a sign-in on myhoadashboard.com works for `/tangomar` and `/a/tango-mar` on that host.
- Email links use the association canonical base once `vanity_slug` is set: `https://myhoadashboard.com/tangomar/...`. Until the migration is applied, Tang-O-Mar links stay on `https://mytangomar.com`. Localhost still prints a localhost link when email is not sent.
- Platform admin page: `/platform/associations`. `PLATFORM_ADMIN_EMAILS` defaults to `marc@whpinc.com`. That page edits each association's neighborhood code and public slug.

## Cloudflare steps for this change

Do these in the dashboard or on deploy. Deploy does not apply D1 migrations.

1. Confirm the zone `myhoadashboard.com` is on account `f1c59948520f1ec39473238b621c7e24` (the same account as Worker `tango`).
2. Deploy (`npx wrangler deploy`) so the custom domains in `wrangler.jsonc` attach. Wrangler creates proxied DNS for the apex and `www`. SSL is issued for those custom domains.
3. `LEGACY_HOST_REDIRECT` is `1`. `mytangomar.com` and `www.mytangomar.com` 301 to `https://myhoadashboard.com/tangomar` and keep the path and query.
4. Paste `migrations/0017_neighborhood_codes.sql` into the D1 console for database `tango` (after `0016`), or run `npm run db:migrate:remote`. Until this runs, codes do not resolve and new email links stay on mytangomar.com. Those old links still 301 onto `/tangomar` once the flag is on.
5. Paste `migrations/0018_fee_schedule.sql` after `0017`, or run `npm run db:migrate:remote`. Until this runs, dues stay one flat invoice per lot. After it runs, Tang-O-Mar has a fee schedule (first improved $625, additional improved $315, vacant $220, Beach box $150) and new dues years bill one itemized invoice per owner. Existing invoices are left as they are.
6. `EMAIL_FROM` stays `Tang-O-Mar <donotreply@mytangomar.com>` until a sender on myhoadashboard.com is verified in Resend. The link in the message can already point at myhoadashboard.com.

## Data and images

- Database: D1 `tango` (id `d3f6cfd2-cae0-42ef-843f-b5465efebd2b`), binding `DB`. Schema is in `migrations/` (0001 to 0018 so far). `0016_seed_seaside_demo.sql` adds the public demo association only. It does not read or update Tang-O-Mar rows. `0017_neighborhood_codes.sql` adds unique `neighborhood_code` and `vanity_slug` on `associations`, sets Tang-O-Mar to code `850` and slug `tangomar`, and sets the demo to code `100` and slug `seaside`. `0018_fee_schedule.sql` adds fee rates, add-ons, owner primary lots, and invoice lines. It seeds Tang-O-Mar only and does not rewrite existing invoices.
- Document files: R2 bucket `tango-documents`, binding `DOCUMENTS`. D1 stores version metadata and the object key.
- Logo, images, video, and small browser scripts: `public/`, served as static assets (matching URLs are served before the Worker runs).
- Email: Resend (`https://api.resend.com/emails`).
- No KV.

## Secrets and env vars (names only)

- Secret: `RESEND_API_KEY`
- Vars in `wrangler.jsonc`: `APP_ENV` (`production`), `EMAIL_FROM` (`Tang-O-Mar <donotreply@mytangomar.com>`), `LEGACY_HOST_REDIRECT` (`1`), `PLATFORM_ADMIN_EMAILS` (`marc@whpinc.com`)
- Local only: `.dev.vars` (gitignored, see `.dev.vars.example`).

## Cron and scheduled jobs

- `15 6 * * *` (06:15 UTC, 12:15 AM CST or 1:15 AM CDT), set in `wrangler.jsonc`. `scheduled()` in `src/index.ts` runs `runDueAssessmentInvoices`, which creates invoices for assessments whose open date has arrived and catches up a missed day. The job skips association id `assoc_seaside_demo`, so the sample ledger does not change.

## How it deploys

- Cloudflare Workers Builds, auto deploy on merge to `main`. Repo `marcongit850/tango`, Worker tag `4813217a722544629cf506ff7f6761ac`, trigger `07af400f-a3e6-4aad-913c-6bc45ce832dc`, build command empty, deploy command `npx wrangler deploy`, root `/`.
- If a merge does not deploy: `POST /accounts/f1c59948520f1ec39473238b621c7e24/builds/triggers/07af400f-a3e6-4aad-913c-6bc45ce832dc/builds` with body `{"branch": "main", "commit_hash": "<full 40 character sha>"}`. Check builds with `GET /accounts/f1c59948520f1ec39473238b621c7e24/builds/workers/4813217a722544629cf506ff7f6761ac/builds?per_page=2` and match `commit_hash`.

## Public read-only demo

Anyone can open a fictional association from the public home page without a magic link. The link is "Try the demo". The same resident and admin routes render it.

- Slug `seaside-demo`, id `assoc_seaside_demo`, display name Seaside Demo HOA. Neighborhood code `100`, public slug `seaside` (from `0017`). People, lots, documents, announcements, dues, notices, and messages are seeded by `migrations/0016_seed_seaside_demo.sql`. That file must be applied by hand before the pages have data. Deploy does not apply it.
- Cookie `tango_demo` is `owner` or `admin`. It is not a row in `sessions`. `/demo` and `/demo/owner` set `owner` and open the sample dashboard. `/demo/admin` sets `admin` and opens admin. `/demo/leave` clears the cookie.
- On `/a/seaside-demo`, the Worker ignores `tango_session` and loads only the seeded persona for that association. Riley Coast is the owner. Quinn Harbor is the board admin. A real Tang-O-Mar login is not used on these pages.
- The demo cookie, and a session whose user id is one of the seeded demo people, does not authenticate `/a/tango-mar` or any other association. Login will not email those addresses or create a session for them.
- POST, PUT, PATCH, and DELETE under `/a/seaside-demo` stop in middleware, before a route handler runs. The visitor is sent back with "Demo only, changes are not saved". Those requests do not write D1, do not upload files, and do not send email.
- Sample covenant, budget, and minutes files are static text in `src/lib/demo.ts`. Opening them does not read or write Tang-O-Mar objects in R2, and it does not run the Tang-O-Mar seed-file writer.
- Demo pages show the banner "Demo site, sample data, read only", with links to view as Owner or as Board admin.

## Known gotchas

- D1 migrations are NOT applied by deploy. Each new `migrations/00NN_*.sql` is applied by hand (paste into the D1 console for database `tango`, or `npm run db:migrate:remote`) before the PR that needs it is merged. `migrations/0016_seed_seaside_demo.sql` is required for the public demo. Until it is applied, `/demo` says the demo is not ready and does not show Tang-O-Mar data. `migrations/0017_neighborhood_codes.sql` is required for neighborhood codes and `/tangomar`. Until it is applied, `/a/tango-mar` still works and email links stay on mytangomar.com. `migrations/0018_fee_schedule.sql` is required for the fee schedule. Until it is applied, Admin, Ledger shows the paste steps and dues stay one flat invoice per lot.
- The cron list in `wrangler.jsonc` replaces any cron added in the dashboard on every deploy. Change schedules in the file, not the dashboard.
- Estoppel requests go to `ESTOPPEL_INBOX` in `src/lib/estoppel.ts` (marc@whpinc.com for now, to be changed later). The page links Florida Statute 720.30851.
- Demo requests go to `DEMO_INBOX` in `src/lib/demo-request.ts` (marc@whpinc.com).
- The estoppel rate limit (5 per IP per 10 minutes) lives in Worker memory, so a restart clears it.
- `EMAIL_FROM` must use a domain verified in Resend (mytangomar.com). Without `RESEND_API_KEY`, no mail goes out and production does not print magic links.
- Sample covenants and budget files are written into R2 the first time someone opens Documents. Replace them by uploading new versions.
- Uploads are limited to PDF, text, JPEG, PNG, WebP, and Word, up to 8 MB.

## Standing rule

Any PR that changes architecture (new secret, cron, storage, binding, or deploy change) must update this file in the same PR.
