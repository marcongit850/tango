# Tango Mar owner portal

Neighborhood OS for a small property owners association that still keeps its roster in Excel. This repository is one Cloudflare Worker. The first association is **Tango Mar**, a beach neighborhood in Miramar Beach, Walton County, Florida.

The public home page is the Tango Mar entry: a full-bleed boardwalk photo, resident login, and request access. Someone who is already signed in sees Open dashboard, and Admin when they are a board member, plus their name and log out. `/a/{slug}` redirects to that home page.

One deployment can host many associations. Each association's lots, balances, documents, and messages stay inside that association. A resident sees only the lots linked to their login. Other residents never see that ledger.

This is the Phase 0 foundation and Phase 1 scaffold: magic-link sign-in, a D1 data model, CSV import, homeowner balances, versioned documents, neighborhood news, private board messages, and board admin. It is not a property-management suite.

## For Marc: signed-in dashboard

On https://mytangomar.com the signed-in dashboard keeps the same navigation and the same account tools. The page uses clear square panels for account balance, lot dues, news, and upcoming events, in the coastal sand and teal already used on the site. The page background is the same soft sand used on the rest of the signed-in portal. Invoices, payments, and personal notices stay on the page.

Ask the portal is a button at the bottom right of signed-in pages. Opening it shows a chat-style panel titled Ask the portal, with a short line about covenants, bylaws, and your lot. The panel says SUBSCRIPTION REQUIRED. The message box is disabled. Nothing is sent, and no assistant is connected. The paid assistant can be added later.

## Phase 1 includes

- Magic-link email login. No passwords.
- Homeowner dashboard: account balance, lot dues, news, upcoming events, invoices, recorded payments, late fees, and personal notices.
- Documents in nine categories, with versions. On the Documents page each category is a collapsed folder. A file can sit in the category, or in an optional subfolder such as a year under Meeting Minutes. Categories with no subfolders open straight to their files. Residents see the version the board marks current. Budgets can be board-only. Publishing a file can email a short portal link when Email owners is checked. Board-only files go only to board logins, and the email does not include the file.
- News, emergency notices, meetings, calendar, FAQs, and board contacts. Posting or saving an announcement or event can email active logins the same way. FAQ and contacts do not.
- Private resident-to-board messages, plus portal notifications. The resident who started a thread can delete that thread. Board admins can delete a thread or one reply. Deleting a thread removes its portal notifications. A portal notice can include an optional file the owner views or downloads in the portal. Posting a notice to one owner can also email that login when Email owner is checked. The note has the title, a short message, a link to Notices, and the file attached to the email. The box starts unchecked. If Resend is not configured, the notice is still saved and the flash says the email was not sent.
- Board tools: owners and lots, delinquent accounts, homeowner and board roles with an admin flag, login email edits, deleting a person, CSV import, invoices, annual dues, recorded payments (edit or delete a payment on an invoice), deleting a lot that has no invoices or payments, news editing, documents (visibility and delete), an accountant CSV, join requests, incoming messages (delete a thread or a reply), and an activity log.
- Public home with resident login and request access.

## Not in this phase

Moderated forum, online card or ACH payments, ARC requests, SMS, and a working AI covenant assistant. Signed-in pages include an Ask the portal placeholder that says subscription required and does not call a model. A board officer can email one owner a balance reminder. Email owners on an announcement, event, or document starts unchecked, so a save does not email anyone unless the board checks it. Email owner on a portal notice also starts unchecked, and a checked notice attaches its file when there is one. The request to join form stores a note for the board. It does not create a login until a board member approves it.

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

A person with edit access can change the legal name and mailing address from the Board page. Edit `migrations/0002_seed_tango_mar.sql` when a fresh database should start with a different address.

## CSV import

People with edit access import owners from Excel by saving the sheet as **CSV UTF-8**. The sample file is `samples/tango-mar-owners.csv`. In the portal: Admin, CSV import.

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
| `admin` | `yes` or `no` for a homeowner or a board member. Blank keeps an existing edit-access flag. A new row with a blank `admin` cell does not get edit access. |
| `starting_balance` | Dollars owed. `375.50` and `$1,200.00` both work. A negative amount is recorded as an opening credit. Blank means zero. |
| `balance_as_of` | `YYYY-MM-DD`. Blank uses today in the association time zone. |
| `phone` | Stored on the user. Shown on Owners and lots and when that lot is opened. Other residents do not see it. |
| `city`, `state`, `postal_code` | Default to the association's city, state, and postal code. |
| `house_name` | Name on the lot, such as MELOMAR. A blank cell keeps the name already stored. |
| `mailing_street`, `mailing_city`, `mailing_state`, `mailing_postal_code` | Where mail for that lot should go when it is not the lot address. A blank cell keeps the value already stored. |
| `owner2_name` | Name for a second person on the same lot. Used only when `owner2_email` is filled in. |
| `owner2_email` | Login for that co-owner. Creates or reuses the person, gives them an active homeowner membership (an existing board role is kept, and edit access is not changed), and links them to the lot without replacing the primary owner. Blank means no co-owner. |
| `owner2_phone` | Phone for that co-owner when the login is new, or when no phone is saved yet. |

Admin notes are not imported. Add those on the lot in Owners and lots.

A positive starting balance creates one invoice named `Opening balance (CSV import)`. Importing the same lot again updates the person and lot and does not add a second opening invoice. Change a balance later from Admin → Ledger: click the dollar amount, then open the invoice.

The first person linked to a lot is the primary owner. A later row with the same `lot_number` and a different email does not take primary away. That person is linked as another owner. If the email is already linked to the lot, the primary flag stays as it is. Re-importing the primary owner updates that person's name, phone, and role, and does not remove other owners. Change who is primary from Owners and lots, Edit, Make primary.

`owner2_email` on the same row is the same kind of co-owner link. A blank `owner2_email` does nothing, even if `owner2_name` or `owner2_phone` is filled in. An existing login keeps its name, and keeps its phone when one is already saved.

Importing the sample file onto the seed data adds Quinn Harper (board, Lot 41, $1,200 opening balance), refreshes the three demo rows, and links Alex Kim (`alex.kim@example.com`) as a co-owner of lot 14. Sam Rivera stays the primary owner of that lot.

## Create D1 and bind it

`wrangler.jsonc` binds `DB` to the existing D1 database `tango` (`d3f6cfd2-cae0-42ef-843f-b5465efebd2b`).

Apply the schema and the Tango Mar seed to that remote database:

```bash
npm run db:migrate:remote
```

That runs `wrangler d1 migrations apply tango --remote`.

## Request to join

The home page links to `/join` (Request access). The form asks for a name, an email, an optional address or lot, and an optional note. A successful submit stores a pending row in `join_requests` for Tango Mar, adds a portal notice for each person with edit access, and emails those people when `RESEND_API_KEY` is set. Sending the form does not create a login.

Admins open Admin, Join requests. **Approve** creates or reuses a user for that email, gives them an active homeowner membership (an active board login keeps that role and its admin flag, and an active homeowner keeps edit access if it is already on), and marks the request approved. When the address matches exactly one active lot and that lot has no owner, Approve links the person to it. A blank address, no match, more than one match, or a lot that already has an owner is left for Owners and lots. **Decline** marks the request declined and does not create a login. A declined request can still be approved later. **Delete** removes the request. It does not remove a login that Approve already created. **Mark reviewed** only changes the status. It does not create a login. A reviewed request can still be approved or declined later.

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

- Admin, Owners and lots: edit a lot, set improved or unimproved, and assign the primary owner. In Edit, Add owner to this lot adds another person to that lot. Make primary and Remove from lot are on each linked person there, and on the lot page under the phone numbers. House name, mailing address, and admin notes are edited on that roster and on the lot page. Open a person under Users to change the login email. That keeps the same user and the lots already linked to them, and it is refused when another person already uses that email. CSV import remains the bulk path.
- Admin, Ledger, Annual dues: add a year (this creates both amounts). On the open date, matching lots are invoiced automatically. Check **Assign this assessment to matching lots** only when you want those invoices before the open date. That writes the invoices Upcoming assessments uses. Changing an amount later does not rewrite invoices already assigned. Click a dollar amount under Assessments and balances to change one invoice.
- Admin, Ledger, Assessments and balances: click a dollar amount to open that lot's invoices, then edit or delete one. See [Edit an invoice](#edit-an-invoice). No new D1 SQL is required for that.
- Admin, Messages: incoming from owners.
- The activity page is the old audit log. The database table is still `audit_log`.

If this Worker is deployed before the SQL runs, current board members can still sign in. Saving a role, setting lot type, assigning dues, or declining a request will ask you to apply this file first.

Someone with a terminal can apply the same file with `npm run db:migrate:remote` after `0004` is already on the remote database.

## Edit an invoice

No D1 migration. Marc does not paste SQL for this change. Amount, late fee, issued date, due date, description, and status are already columns on `invoices`.

On Admin, Ledger, click a dollar amount under Assessments and balances. That opens the lot's invoices. The same amounts on Owners and lots, and on a person's page, open that lot too. Click an invoice amount to edit it or delete it. Only a board admin can open these pages.

Save updates that bill. Open, partial, and paid follow payments recorded on it. Void leaves the invoice off the balance. A recorded payment stays on the lot when you save the invoice. Each payment on that invoice can be edited or deleted. Edit uses the same amount, paid date, method, reference, and notes as recording a payment, and it does not ask for a separate confirm. Saving or deleting a payment writes an activity log entry and sets the invoice status from the payments that remain. Delete still uses the confirm checkbox. Invoice delete still asks for confirmation and stays blocked while a payment is recorded on that invoice. After the last payment is gone, the invoice can be deleted. Deleting an invoice leaves its assessment in place. Deleting an assessment still removes its unpaid invoices and stays blocked when a payment is recorded on one of them.

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

## Document folders (paste this before merge)

`migrations/0008_document_folders.sql` adds an optional subfolder on each document and allows the Insurance category. Paste it in the Cloudflare dashboard before you merge the pull request. Marc does not need a terminal.

What it does:

- Adds `folder` on `documents`. Existing rows start blank, so those files stay directly in their category.
- Allows the Insurance category (`insurance_docs`). Other stays the category it already was.
- The Budgets label uses the existing budgets category, so a file already filed there stays in Budgets.
- Rebuilds `documents` and `document_versions` so the category check can include Insurance. File bytes in R2 are not moved.

Dashboard steps:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database**.
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0008_document_folders.sql`.
5. Select **Execute**.

Run that file once, after `0007`. If the console says `documents_folder_migration` already exists, this file was already applied. Do not paste it again.

Publishing Insurance, or saving a year or subfolder, before this runs asks you to apply the file first. A file in an existing category with the subfolder left blank still publishes.

If a document date has already been saved, do not paste this file. It rebuilds `documents` and clears `folder` and `document_date`. The portal adds those columns when a date is saved, which is enough for Meeting Minutes and Budgets. Paste this file first only when you still need the Insurance category and no date has been saved yet.

Someone with a terminal can apply the same file with `npm run db:migrate:remote` after `0007` is already on the remote database.

## Document date (paste this before merge)

`migrations/0010_document_date.sql` stores a date on each document. Paste it in the Cloudflare dashboard before you merge the pull request. Marc does not need a terminal.

What it does:

- Adds `document_date` on `documents`. Existing rows start blank.
- On Meeting Minutes, Budgets, and Insurance, that date files the document in a year folder such as `2024`. A second file with the same year reuses that folder. An extra subfolder such as `January` stays under the year.
- Bylaws, Other, and the other categories stay flat. A date is saved, and it does not create a year folder.

Dashboard steps:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database**.
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0010_document_date.sql`.
5. Select **Execute**.

Run that file once, after `0009`. If the console says a column already exists, this file was already applied. Do not paste it again.

Saving a date also adds `document_date` and `folder` when those columns are missing, so an existing Meeting Minutes or Budgets file can take a date after deploy even before this paste. Insurance as its own category still needs `0008` first, and that paste has to happen before any date is saved.

Someone with a terminal can apply the same file with `npm run db:migrate:remote` after `0009` is already on the remote database.

## Master admin (paste this before merge)

`migrations/0009_master_admin.sql` marks one master admin on each association. Paste it in the Cloudflare dashboard before you merge the pull request. Marc does not need a terminal.

What it does:

- Adds `is_master` on `memberships`. The flag belongs to that person's membership in one association, so a later neighborhood can have its own master.
- If `marc@whpinc.com` already has a membership, that membership is the master. Edit access is turned on, and the membership is set active so that login can sign in. The role stays as it is (homeowner or board).
- If that login is not a member of an association, the earliest active person who already has edit access in that association becomes the master. On the demo roster that person is Jordan Lee (`jordan.lee@example.com`), because Marc is not in the seed. A live Tango Mar database that already has Marc uses Marc, not Jordan.
- At most one master per association. Other people with edit access can still lose that access or be deleted. The portal still keeps at least one person with edit access.
- The master cannot be deleted. Saving a role that would turn off edit access, or mark the master inactive, is refused.

Dashboard steps:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database**.
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0009_master_admin.sql`.
5. Select **Execute**.

Run that file once, after `0008`. If the console says a column already exists, this file was already applied.

On the person page, the master row says Master admin. Edit access is checked and cannot be cleared, and Delete person is not offered. Until this file runs, delete and edit access behave as they do today.

Someone with a terminal can apply the same file with `npm run db:migrate:remote` after `0008` is already on the remote database.

## Lot details (paste this before merge)

`migrations/0011_lot_details.sql` adds house name, mailing address, and admin notes on each lot. Paste it in the Cloudflare dashboard before you merge the pull request. Marc does not need a terminal.

What it does:

- Adds `house_name` on `properties`. Existing lots start blank.
- Adds `mailing_street`, `mailing_city`, `mailing_state`, and `mailing_postal_code` for mail that should not go to the lot address. Existing lots start blank, which means mail still goes to the lot address.
- Adds `admin_notes` on `properties`. Only admin pages show or save that text. Owner pages do not include it.
- Phone numbers stay on the person. Opening a lot shows the phone for each linked owner.

Dashboard steps:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **D1 SQL database**.
2. Select the database named **tango**.
3. Open **Console**.
4. Paste the full contents of `migrations/0011_lot_details.sql`.
5. Select **Execute**.

Run that file once, after `0010`. If the console says a column already exists, this file was already applied. Do not paste it again.

After it succeeds, use Admin, Owners and lots. The property roster is that page. Users, lower on the same page, is only sign-in accounts: email, admin access, and last login. Open a lot to see every linked phone number. Owners see house name, mailing address, and phones on their own lot. They do not see admin notes.

Someone with a terminal can apply the same file with `npm run db:migrate:remote` after `0010` is already on the remote database.

## Second owner on a lot

No D1 migration. Marc does not paste SQL for this change. A lot can already have more than one row in `property_owners`.

Open Admin, Owners and lots, then Edit on a lot. Add owner to this lot asks for a name, an email, and an optional phone. The email is stored in lowercase. If that email already has a login, that login is reused. An existing board role stays. Edit access and the master admin flag are not changed. The new link is primary only when the lot does not already have a primary owner. Otherwise the person is another owner and the current primary stays primary. The page says they can sign in with a magic link at their email.

That Edit panel lists every person linked to the lot, with a Primary label. Make primary switches which linked person is primary. Remove from lot unlinks that person and does not delete the login. Removing the last owner is allowed. Removing the primary owner while someone else is still linked promotes the oldest remaining link to primary.

The lot page under Admin, Ledger has the same list and form under the phone numbers. Edit access is required to add, remove, or change the primary owner.

Any linked owner, including one who is not primary, sees that lot, its balance, and its invoices after signing in. CSV import can add the second person with `owner2_email`. See [CSV import](#csv-import).

## Delete a person or a lot

Board admins can remove a person or a lot. Deleting a person does not need its own migration. The master admin lock is `migrations/0009_master_admin.sql`, described above.

Open the person from Admin, Owners and lots, under Users, for example [https://mytangomar.com/a/tango-mar/admin/owners](https://mytangomar.com/a/tango-mar/admin/owners). Check **Delete this person**, then submit. That removes the login, sessions, magic links, membership, lot links, notices, and messages they sent. Lots and their invoices stay. The portal keeps at least one person with edit access. The master admin for this association cannot be deleted. If that login is also a member of another association, only this association's membership is removed and the account stays. A master in another association is a different membership, so removing someone here does not remove that other lock.

Open a lot from the ledger, for example [https://mytangomar.com/a/tango-mar/admin/ledger](https://mytangomar.com/a/tango-mar/admin/ledger) and then the lot. Check **Delete this lot**, then submit. The lot and its owner links are removed when it has no invoices and no payments. A lot that still has either stays in place, and the page says to clear those first. Invoices on that page still open for edit, and a payment on an invoice is edited or deleted from the invoice page.

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

## Automatic invoices on the open date

No D1 migration. Marc does not paste SQL for this change.

When an assessment has an open date, and that date is today in the association time zone (or any earlier date that is still not fully invoiced), the Worker creates one invoice for each active lot of that assessment's lot type. Improved assessments go only to improved lots. Unimproved assessments go only to unimproved lots. An assessment set to all lots goes to every active lot. Lots that already have an invoice for that assessment, including a voided one, are skipped. The invoice uses the open date as the issued date and the assessment due date as the due date, the same as **Assign to matching lots**. A future open date stays off the balance until that date. A blank open date is not automatic.

The schedule is in `wrangler.jsonc`: `15 6 * * *`. That is 6:15 AM UTC, which is 12:15 AM Central Standard Time and 1:15 AM Central Daylight Time, so Tango Mar (`America/Chicago`) has already reached the open date. The next deploy with Wrangler installs this trigger and replaces any other cron triggers on the Worker. Adding a second schedule in the dashboard does not stick after the next `npx wrangler deploy`.

After you deploy, confirm the trigger. This can take up to 15 minutes to show up.

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and go to **Workers & Pages**.
2. In **Overview**, select the Worker named **tango**.
3. Open **Settings**.
4. Open **Triggers**.
5. Under **Cron Triggers**, confirm the schedule is `15 6 * * *`.
6. If the list is empty, select **Add Cron Trigger**, enter `15 6 * * *`, and save. Do not add any other schedule.

To see that it ran: on the same Worker, open **Settings**, then under **Trigger Events** select **View events**.

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
| Homeowner | Their own lots, invoices, payments, and messages. Current resident documents. With edit access, they can also open admin tools and change them. |
| Board member | Same resident access, plus board-only documents. Admin pages open view-only: Overview, ledgers, documents, and the other read pages. Create, edit, and delete stay off until edit access is checked. |
| Edit access | Checkbox on the person page (`is_admin`). A homeowner or a board member with it can use the admin write tools. New people do not have it until it is checked. A board member without it can still view admin pages. A homeowner without it only sees their own lots. Keep at least one person with edit access. |
| Master admin | One membership per association (`is_master`). That person keeps edit access and cannot be deleted. Other people with edit access stay removable. For Tango Mar this is `marc@whpinc.com` when that membership exists. |

A board member's dashboard still shows only their own lots. Other residents' balances are on the admin ledger. View-only board members can open that ledger but cannot change it.

## Data model

Migrations live in `migrations/`.

- `associations`, `users`, `roles`, `memberships` (`is_admin` is edit access on a homeowner or a board member; a board member without it is view-only; `is_master` is the one locked master admin for that association)
- `properties` (lots, with `lot_type` of `improved` or `unimproved`, plus `house_name`, mailing address, and `admin_notes`) and `property_owners`
- `assessments` (`opens_on`, `lot_type`, amount, due date), `invoices`, `payments` (amounts in cents; payments are recorded, not charged online)
- `documents` and `document_versions` (`current_version_id` is what residents see; `visibility` is `residents` or `board`; `folder` is an optional subfolder; `document_date` is the date that files Meeting Minutes, Budgets, and Insurance into a year folder)
- `announcements`, `events`, `faqs`, `board_contacts`
- `messages` (private threads to the board)
- `notifications` (portal notices, with an optional file in R2)
- `audit_log` (shown in the portal as Activity)
- `magic_links`, `sessions`
- `join_requests` (public request to join: pending, reviewed, approved, or declined)

Every tenant-owned row carries `association_id`. Financial queries also require that association id, and homeowner queries join `property_owners` for the signed-in user. Admin read pages require an active board member, or a homeowner with edit access, in that association. Creating, editing, and deleting also require edit access.

Balance = non-void invoice amounts + late fees − recorded payments.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Local Worker with `APP_ENV=development` |
| `npm run check` | Typecheck |
| `npm test` | Unit tests for CSV parsing, money, access rules, Central Time, join approval, and automatic assessment invoices |
| `npm run db:migrate:local` | Apply D1 migrations locally |
| `npm run db:migrate:remote` | Apply D1 migrations to the bound remote database |
| `npm run types` | Regenerate `worker-configuration.d.ts` after binding changes |
| `npm run deploy` | `wrangler deploy` |

## Project layout

```text
migrations/          D1 schema and Tango Mar seed
samples/             Example owner CSV
src/index.ts         Worker entry, including the daily assessment invoice cron
src/app.ts           Routes and session loading
src/routes/          Public, auth, resident, and board handlers
public/              Static files, including the Tango Mar header logo
src/views/           Server-rendered HTML
src/db.ts            Tenant-scoped queries
src/lib/             CSV, money, tokens, access rules
```
