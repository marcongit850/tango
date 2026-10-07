# Tango Mar owner portal

Neighborhood OS for a small property owners association that still keeps its roster in Excel. This repository is one Cloudflare Worker. The first association is **Tango Mar**, a beach neighborhood in Miramar Beach, Walton County, Florida.

The public home page is the Tango Mar entry: a full-bleed boardwalk photo, resident login, and request access. Someone who is already signed in sees Open dashboard, and Admin when they have admin access, plus their name and log out. `/a/{slug}` redirects to that home page.

One deployment can host many associations. Each association's lots, balances, documents, and messages stay inside that association. A resident sees only the lots linked to their login. Other residents never see that ledger.

This is the Phase 0 foundation and Phase 1 scaffold: magic-link sign-in, a D1 data model, CSV import, homeowner balances, versioned documents, neighborhood news, private board messages, and board admin. It is not a property-management suite.

## Phase 1 includes

- Magic-link email login. No passwords.
- Homeowner dashboard: balance, upcoming assessments, invoices, recorded payments, late fees, and personal notices.
- Documents in eight categories, with versions. Residents see the version the board marks current. Budgets can be board-only. Publishing a file can email a short portal link when Email owners is checked. Board-only files go only to board logins, and the email does not include the file.
- News, emergency notices, meetings, calendar, FAQs, and board contacts. Posting or saving an announcement or event can email active logins the same way. FAQ and contacts do not.
- Private resident-to-board messages, plus portal notifications. A portal notice can include an optional file the owner views or downloads in the portal. Posting a notice to one owner can also email that login when Email owner is checked. The note has the title, a short message, a link to Notices, and the file attached to the email. The box starts unchecked. If Resend is not configured, the notice is still saved and the flash says the email was not sent.
- Board tools: owners and lots, delinquent accounts, homeowner and board roles with an admin flag, login email edits, CSV import, invoices, annual dues, recorded payments, news editing, documents (visibility and delete), an accountant CSV, join requests, incoming messages, and an activity log.
- Public home with resident login and request access.

## Not in this phase

Moderated forum, online card or ACH payments, ARC requests, SMS, and an AI covenant assistant. A board officer can email one owner a balance reminder. Email owners on an announcement, event, or document starts unchecked, so a save does not email anyone unless the board checks it. Email owner on a portal notice also starts unchecked, and a checked notice attaches its file when there is one. The request to join form stores a note for the board. It does not create a login until a board member approves it.

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
| jordan.lee@example.com | Board member with admin | 3 | No balance |
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

People with admin access import owners from Excel by saving the sheet as **CSV UTF-8**. The sample file is `samples/tango-mar-owners.csv`. In the portal: Admin, CSV import.

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
| `role` | `homeowner` (default) or `board`. An older sheet may still say `officer`. That becomes a board member with admin. |
| `admin` | `yes` or `no`. Blank keeps an existing admin flag for a board member. A new board row with a blank `admin` cell does not get admin. Admin on a homeowner row is rejected. |
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

The home page links to `/join` (Request access). The form asks for a name, an email, an optional address or lot, and an optional note. A successful submit stores a pending row in `join_requests` for Tango Mar, adds a portal notice for each person with admin access, and emails those people when `RESEND_API_KEY` is set. Sending the form does not create a login.

Admins open Admin, Join requests. **Approve** creates or reuses a user for that email, gives them an active homeowner membership (an active board login keeps that role and its admin flag), and marks the request approved. When the address matches exactly one active lot and that lot has no owner, Approve links the person to it. A blank address, no match, more than one match, or a lot that already has an owner is left for Owners and lots. **Decline** marks the request declined and does not create a login. A declined request can still be approved later. **Delete** removes the request. It does not remove a login that Approve already created. **Mark reviewed** only changes the status. It does not create a login. A reviewed request can still be approved or declined later.

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

## Admin improvements (paste this before merge)

`migrations/0005_admin_improvements.sql` is the SQL for this batch. Paste it in the Cloudflare dashboard before you merge the pull request. Marc does not need a terminal.

What it does:

- Adds an admin flag on memberships. People who already administer the association (board or officer) keep that access. Officers become board members. The officer role is removed.
- Adds lot type on each lot. Existing lots start as improved. Change unimproved lots under Admin, Owners and lots.
- Adds an open date and lot type on assessments, so annual dues can be improved ($625, open January 1, due March 1) or unimproved ($100, same dates).
- Lets a join request be marked declined. Pending, reviewed, and approved rows stay.

Dashboard steps:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database**.
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0005_admin_improvements.sql`.
5. Select **Execute**.

Run that file once. If the console says a column already exists, or `join_requests_next` already exists, a previous paste stopped halfway. Run `DROP TABLE IF EXISTS join_requests_next;` only if that table is still there and `join_requests` is still the live table, then execute the file again. Do not drop `join_requests` by itself.

After it succeeds, use the portal:

- Admin, Owners and lots: edit a lot, set improved or unimproved, and assign the primary owner. Open a person to change the login email. That keeps the same user and the lots already linked to them, and it is refused when another person already uses that email. CSV import remains the bulk path.
- Admin, Ledger, Annual dues: add a year (this creates both amounts), then check **Assign this assessment to matching lots** and choose **Assign to matching lots**. That writes the invoices Upcoming assessments uses. Changing an amount later does not rewrite invoices already assigned.
- Admin, Messages: incoming from owners.
- The activity page is the old audit log. The database table is still `audit_log`.

If this Worker is deployed before the SQL runs, current board members can still sign in. Saving a role, setting lot type, assigning dues, or declining a request will ask you to apply this file first.

Someone with a terminal can apply the same file with `npm run db:migrate:remote` after `0004` is already on the remote database.

## Portal notice files (paste this before merge)

`migrations/0006_notice_attachments.sql` stores an optional file on a portal notice. Paste it in the Cloudflare dashboard before you merge the pull request. Marc does not need a terminal.

What it does:

- Adds filename, content type, R2 object key, and size on `notifications`.
- Existing notices stay as they are. The new columns start empty.
- The file bytes go in the existing `tango-documents` R2 bucket (`DOCUMENTS`), the same bucket documents use.

Dashboard steps:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database**.
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0006_notice_attachments.sql`.
5. Select **Execute**.

Run that file once, after `0005`. If the console says a column already exists, this file was already applied.

Posting a notice with a file before this runs asks you to apply the file first. A notice without a file still posts. On the owner page, the file is optional (PDF, text, image, or Word, 8 MB or smaller). The owner can view or download it from Notices and from the notice on their dashboard. If Email owner is checked, the email includes a link to Notices and attaches that file.

Someone with a terminal can apply the same file with `npm run db:migrate:remote` after `0005` is already on the remote database.

## Mark a message reviewed (paste this before merge)

`migrations/0007_message_reviewed.sql` lets the board clear a thread from **Messages waiting on the board** without sending a reply. Paste it in the Cloudflare dashboard before you merge the pull request. Marc does not need a terminal.

What it does:

- Adds `reviewed_at` on `messages`. Existing rows start empty, so a thread whose latest message is from an owner still counts as waiting.
- Mark reviewed stamps the latest message on that thread. The waiting count skips it.
- A new message from the owner is a new row, so that thread counts as waiting again.
- Opening a thread does not clear it. A board reply still clears it, because the latest message is then from the board.

Dashboard steps:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database**.
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0007_message_reviewed.sql`.
5. Select **Execute**.

Run that file once, after `0006`. If the console says a column already exists, this file was already applied.

On Admin, Messages, **Mark reviewed** is on the thread and on the inbox row. Until this file runs, the waiting count still works and Mark reviewed asks you to apply it first.

Someone with a terminal can apply the same file with `npm run db:migrate:remote` after `0006` is already on the remote database.

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
| Public | Logged-out visitor. Public home, resident login, and request access. No documents and no balances. |
| Homeowner | Their own lots, invoices, payments, and messages. Current resident documents. |
| Board member | Same resident access, plus board-only documents. Admin tools stay off unless the admin flag is on. |
| Admin flag | A board member who can open Admin. Keep at least one active admin so the portal cannot lock itself out. |

A board member's dashboard still shows only their own lots, even when the admin flag is on. Other residents' balances are on the admin ledger, not on the personal dashboard.

## Data model

Migrations live in `migrations/`.

- `associations`, `users`, `roles`, `memberships` (`is_admin` is the admin flag on a board member)
- `properties` (lots, with `lot_type` of `improved` or `unimproved`) and `property_owners`
- `assessments` (`opens_on`, `lot_type`, amount, due date), `invoices`, `payments` (amounts in cents; payments are recorded, not charged online)
- `documents` and `document_versions` (`current_version_id` is what residents see; `visibility` is `residents` or `board`)
- `announcements`, `events`, `faqs`, `board_contacts`
- `messages` (private threads to the board)
- `notifications` (portal notices, with an optional file in R2)
- `audit_log` (shown in the portal as Activity)
- `magic_links`, `sessions`
- `join_requests` (public request to join: pending, reviewed, approved, or declined)

Every tenant-owned row carries `association_id`. Financial queries also require that association id, and homeowner queries join `property_owners` for the signed-in user. Admin queries are rejected unless the membership is an active board member with the admin flag for that same association.

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
