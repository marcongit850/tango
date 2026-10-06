# Tango Mar owner portal

Neighborhood OS for a small property owners association that still keeps its roster in Excel. This repository is one Cloudflare Worker. The first association is **Tango Mar**, a beach neighborhood in Miramar Beach, Walton County, Florida.

The public home page is the Tango Mar entry: resident login, and a form to request to join. `/a/{slug}` redirects to that home page.

One deployment can host many associations. Each association's lots, balances, documents, and messages stay inside that association. A resident sees only the lots linked to their login. Other residents never see that ledger.

This is the Phase 0 foundation and Phase 1 scaffold: magic-link sign-in, a D1 data model, CSV import, homeowner balances, versioned documents, neighborhood news, private board messages, and board admin. It is not a property-management suite.

## Phase 1 includes

- Magic-link email login. No passwords.
- Homeowner dashboard: balance, upcoming assessments, invoices, recorded payments, late fees, and personal notices.
- Documents in eight categories, with versions. Residents see the version the board marks current. Budgets can be board-only.
- News, emergency notices, meetings, calendar, FAQs, and board contacts.
- Private resident-to-board messages, plus portal notifications.
- Board tools: roster, delinquents, lots, roles, CSV import, invoices, recorded payments, announcements, documents, an accountant CSV, join requests, and an audit log.
- Public home with resident login and a request to join form.

## Not in this phase

Moderated forum, online card or ACH payments, ARC requests, SMS, an AI covenant assistant, and email blasts. A board officer can email one owner a balance reminder. That is a single message, not a blast. The request to join form stores a note for the board. It does not create a login until a board member approves it.

## Stack

- Cloudflare Workers
- D1 for the database (`DB` binding, database name `tango`)
- R2 for document files (`DOCUMENTS` binding, bucket name `tango-documents`)
- [Resend](https://resend.com) for magic-link email when `RESEND_API_KEY` is set

Local development works without Resend. On `localhost`, or when `APP_ENV` is `development`, a sign-in link that could not be emailed is shown on the next page.

## Local setup

```bash
npm install
npm run db:migrate:local
npm run dev
```

Open http://localhost:8787.

`npm run dev` sets `APP_ENV=development`. The committed Wrangler config leaves `APP_ENV` as `production`, so a deployed Worker does not print magic links.

Apply the migrations before the first request. If the database is missing, the home page explains that step.

### Demo roster

These people are fictional. Lot labels are examples, not a statement about who owns a house.

| Email | Role | Lot | Ledger |
| --- | --- | --- | --- |
| jordan.lee@example.com | Officer / manager | 3 | No balance |
| sam.rivera@example.com | Homeowner | 14 | 2026 dues paid |
| casey.nguyen@example.com | Homeowner | 27 | Opening balance and 2026 dues, past due |

Request a magic link with one of those addresses. On localhost, the confirmation page includes the link when email is not configured.

The seed association is Tango Mar, slug `tango-mar`.

- Legal name: Tango Mar Property Owners Association
- Mailing address in the seed: 31 Tang O Mar Drive, Miramar Beach, FL 32550
- Place: Miramar Beach, Walton County, Florida
- Time zone: `America/Chicago` (Walton County is Central Time)

Edit `migrations/0002_seed_tango_mar.sql` if the mailing address should change, then apply migrations to a fresh database.

## CSV import

Board members and officers import owners from Excel by saving the sheet as **CSV UTF-8**. The sample file is `samples/tango-mar-owners.csv`. In the portal: Admin → CSV import.

Required columns:

| Column | Meaning |
| --- | --- |
| `email` | Login address. Matched case-insensitively. |
| `name` | Person's name. |
| `lot_number` | Unique within the association. |
| `street_address` | Lot address. |

Optional columns:

| Column | Meaning |
| --- | --- |
| `role` | `homeowner` (default), `board`, or `officer`. |
| `starting_balance` | Dollars owed. `375.50` and `$1,200.00` both work. A negative amount is recorded as an opening credit. Blank means zero. |
| `balance_as_of` | `YYYY-MM-DD`. Blank uses today in the association time zone. |
| `phone` | Stored on the user. Visible to the board, not to other residents. |
| `city`, `state`, `postal_code` | Default to the association's city, state, and postal code. |

A positive starting balance creates one invoice named `Opening balance (CSV import)`. Importing the same lot again updates the person and lot and does not add a second opening invoice. Change a balance later from Admin → Ledger.

Importing the sample file onto the seed data adds Quinn Harper (board, Lot 41, $1,200 opening balance) and refreshes the three demo rows.

## Create D1 and bind it

`wrangler.jsonc` binds `DB` to the existing D1 database `tango` (`d3f6cfd2-cae0-42ef-843f-b5465efebd2b`).

Apply the schema and the Tango Mar seed to that remote database:

```bash
npm run db:migrate:remote
```

That runs `wrangler d1 migrations apply tango --remote`.

## Request to join

The home page links to `/join`. The form asks for a name, an email, an optional address or lot, and an optional note. A successful submit stores a pending row in `join_requests` for Tango Mar, adds a portal notice for each active board member and officer, and emails those people when `RESEND_API_KEY` is set. Sending the form does not create a login.

Board members open Admin, Join requests. **Approve** creates or reuses a user for that email, gives them an active homeowner membership (an active board or officer login keeps that role), and marks the request approved. When the address matches exactly one active lot and that lot has no owner, Approve links the person to it. A blank address, no match, more than one match, or a lot that already has an owner is left for the owner page. **Mark reviewed** only changes the status. It does not create a login. A reviewed request can still be approved later.

Approve then sends a welcome email from `EMAIL_FROM` when `RESEND_API_KEY` is set. The message tells them to sign in at https://mytangomar.com/login with the same email. It does not include a magic-link token. If email is not configured or Resend fails, the login still exists and the admin flash says the welcome email was not sent.

`migrations/0003_join_requests.sql` creates that table. Apply it to the live `tango` database before you deploy this version of the Worker. You can do that in the Cloudflare dashboard:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database** (under Storage & databases).
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0003_join_requests.sql`.
5. Select **Execute**.

You should see the `join_requests` table under **Tables**. If the Worker is deployed before this SQL runs, the public form tells the visitor to try again later, and Admin, Join requests explains that the table is missing. The rest of the portal keeps working.

`migrations/0004_join_request_approved.sql` lets a request be marked `approved`. Apply it before using Approve. `npm run db:migrate:remote` applies it after `0003`.

Dashboard steps for that file:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database**.
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0004_join_request_approved.sql`.
5. Select **Execute**.

Run that file once. If Approve says the approval migration is missing, this file has not been applied yet. In that case no login is created. If the console says `join_requests_next` already exists, a previous paste stopped halfway: `DROP TABLE join_requests_next;` and execute the file again.

## Create the R2 bucket

Document bytes live in R2. The database stores the version metadata and the object key.

```bash
npx wrangler r2 bucket create tango-documents
```

The binding name in `wrangler.jsonc` is `DOCUMENTS`, and the bucket name is `tango-documents`. Local `wrangler dev` uses a simulated bucket, so this command is only required before deploy.

The seed covenants and budget are placeholder text, not the recorded documents. The Worker writes those sample files into R2 the first time someone opens Documents. Replace them by uploading a new version and marking it current. Residents then see the new file. Older versions stay available to the board.

Allowed uploads: PDF, plain text, JPEG, PNG, WebP, and Word (`.doc`, `.docx`), up to 8 MB.

## Secrets and email

Do not put API keys in `wrangler.jsonc`.

Production:

```bash
npx wrangler secret put RESEND_API_KEY
```

`EMAIL_FROM` is a normal var: `Tango Mar <donotreply@mytangomar.com>`. mytangomar.com must be verified in Resend Domains before those messages can send.

Local secrets, if you want to send real mail from `wrangler dev`, go in `.dev.vars` (gitignored):

```bash
cp .dev.vars.example .dev.vars
```

Leave `RESEND_API_KEY` empty to keep the on-screen link.

Magic-link tokens and session tokens are stored as SHA-256 hashes. The cookie is `HttpOnly` and `SameSite=Lax`. `Secure` is set when the site is served over HTTPS. Links expire in 20 minutes and work once. Sessions last 30 days.

## Deploy

```bash
npm run check
npm test
npx wrangler deploy
```

`APP_ENV` stays `production` on deploy, so magic links are emailed and are not printed on the page. Set `RESEND_API_KEY` first, or owners will see the generic "check your email" message and no mail will go out.

Preview URLs are public unless you put access control in front of them.

## Roles

| Role | What they can see |
| --- | --- |
| Public | Logged-out visitor. Public home, resident login, and request to join. No documents and no balances. |
| Homeowner | Their own lots, invoices, payments, and messages. Current resident documents. |
| Board member | Homeowner access, plus admin for this association only. |
| Officer / manager | Same admin tools as the board in this phase. |

Keep at least one active officer so the association cannot lock itself out of admin.

A board member's dashboard still shows only their own lots. Other residents' balances are on the admin ledger, not on the personal dashboard.

## Data model

Migrations live in `migrations/`.

- `associations`, `users`, `roles`, `memberships`
- `properties` (lots) and `property_owners`
- `assessments`, `invoices`, `payments` (amounts in cents; payments are recorded, not charged online)
- `documents` and `document_versions` (`current_version_id` is what residents see; `visibility` is `residents` or `board`)
- `announcements`, `events`, `faqs`, `board_contacts`
- `messages` (private threads to the board)
- `notifications` (portal notices)
- `audit_log`
- `magic_links`, `sessions`
- `join_requests` (public request to join: pending, reviewed, or approved)

Every tenant-owned row carries `association_id`. Financial queries also require that association id, and homeowner queries join `property_owners` for the signed-in user. Staff queries are rejected unless the membership role is `board` or `officer` for that same association.

Balance = non-void invoice amounts + late fees − recorded payments.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Local Worker with `APP_ENV=development` |
| `npm run check` | Typecheck |
| `npm test` | Unit tests for CSV parsing, money, access rules, Central Time, and join approval |
| `npm run db:migrate:local` | Apply D1 migrations locally |
| `npm run db:migrate:remote` | Apply D1 migrations to the bound remote database |
| `npm run types` | Regenerate `worker-configuration.d.ts` after binding changes |
| `npm run deploy` | `wrangler deploy` |

## Project layout

```text
migrations/          D1 schema and Tango Mar seed
samples/             Example owner CSV
src/index.ts         Worker entry
src/app.ts           Routes and session loading
src/routes/          Public, auth, resident, and board handlers
public/              Static files, including the Tango Mar header logo
src/views/           Server-rendered HTML
src/db.ts            Tenant-scoped queries
src/lib/             CSV, money, tokens, access rules
```
