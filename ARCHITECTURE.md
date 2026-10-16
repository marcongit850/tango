# Tango Mar owner portal: architecture

Last checked against the code and Cloudflare on Oct 16, 2026.

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
7. Paste `migrations/0019_online_payments.sql` after `0018`, or run `npm run db:migrate:remote`. Until this runs, owners see no Pay now button and Payment settings explains the paste. Online receipt mail uses the existing `EMAIL_FROM` sender. No new Resend domain.
8. Paste `migrations/0020_payment_controls.sql` after `0019`. Until this runs, refunds and disputes do not change the ledger, and the activity log is not append-only. The daily job also writes a payment activity file to R2 only after this table exists.
8b. Paste `migrations/0021_test_payments.sql` after `0020`. Until this runs, a test-mode webhook is not recorded and does not mark an invoice paid.
9. Set the Worker secret `PAYMENT_ENCRYPTION_KEY` (name only; never commit a value). It is a base64-encoded 32-byte AES-GCM key. `openssl rand -base64 32`, then `npx wrangler secret put PAYMENT_ENCRYPTION_KEY`. Optional: `PAYMENT_ENCRYPTION_KEY_ID` (default `1`) and `PAYMENT_ENCRYPTION_KEYS` (a JSON map of older key ids to keys, used only to decrypt). Stripe keys cannot be saved until `PAYMENT_ENCRYPTION_KEY` exists. Keep a backup of the current key in the board password manager. Do not put that backup in git, email, or the activity log.

## Data and images

- Database: D1 `tango` (id `d3f6cfd2-cae0-42ef-843f-b5465efebd2b`), binding `DB`. Schema is in `migrations/` (0001 to 0027 so far). `0016_seed_seaside_demo.sql` adds the public demo association only. It does not read or update Tang-O-Mar rows. `0017_neighborhood_codes.sql` adds unique `neighborhood_code` and `vanity_slug` on `associations`, sets Tang-O-Mar to code `850` and slug `tangomar`, and sets the demo to code `100` and slug `seaside`. `0018_fee_schedule.sql` adds fee rates, add-ons, owner primary lots, and invoice lines. It seeds Tang-O-Mar only and does not rewrite existing invoices. `0019_online_payments.sql` adds `payment_settings`, `stripe_event_receipts`, and `checkout_intents`, and allows payment method `stripe`. It copies existing payments and does not change their amounts. `0020_payment_controls.sql` adds `payment_reversals` and `stripe_adjustment_events`, and makes `audit_log` append-only except for clearing `actor_user_id` when an account is deleted. `0023_late_fees.sql` adds `late_fee_settings` and invoice columns that record an automatic fee or a waiver. It seeds settings for the demo association only. `0024_invoice_emails.sql` adds `invoice_email_settings`, `invoice_email_events`, and the invoice column `emailed_at`. It does not turn invoice emails on for any association. `0025_invoice_resend.sql` adds `invoice_resends` so an admin can email one invoice again. It does not change `emailed_at`. `0026_invoice_resend_recipients.sql` adds `invoice_resend_recipients`, one row per owner a manual resend reached. `0027_invoice_mail.sql` adds `invoice_mail_settings` for the check mailing address and the optional board note on invoice emails. It seeds sample text for Seaside Demo HOA only.
- Document files: R2 bucket `tango-documents`, binding `DOCUMENTS`. D1 stores version metadata and the object key. The bucket is private. There is no public r2.dev URL and no custom domain on the bucket. The Worker binding is the only read path. The payment activity export (`audit/payment-activity-YYYY-MM-DD.jsonl`) is stored in that same private bucket.
- Logo, images, video, and small browser scripts: `public/`, served as static assets (matching URLs are served before the Worker runs).
- Email: Resend (`https://api.resend.com/emails`).
- No KV.

## Secrets and env vars (names only)

- Secret: `RESEND_API_KEY`
- Secret: `PAYMENT_ENCRYPTION_KEY` (base64-encoded 32-byte AES-GCM key). Decrypts each neighborhood's Stripe secret key and webhook signing secret. Those Stripe values are stored only as ciphertext in `payment_settings` (`v2.<key id>.<iv>.<cipher>`), bound to the neighborhood id and the field name. They are not emailed, logged, or sent back to the browser. The page shows "Set, ending in" plus the last four characters, and Replace or Remove.
- Optional secret: `PAYMENT_ENCRYPTION_KEY_ID`. The id stored with new ciphertext. Default `1` when unset.
- Optional secret: `PAYMENT_ENCRYPTION_KEYS`. JSON object of key id to base64 key, for decrypting rows written with an older id. Example shape only: `{"1":"<old key>","2":"<new key>"}`. Never commit a real value.
- Vars in `wrangler.jsonc`: `APP_ENV` (`production`), `EMAIL_FROM` (`Tang-O-Mar <donotreply@mytangomar.com>`), `LEGACY_HOST_REDIRECT` (`1`), `PLATFORM_ADMIN_EMAILS` (`marc@whpinc.com`)
- Local only: `.dev.vars` (gitignored, see `.dev.vars.example`). Do not put a real key value in that example.

## Cron and scheduled jobs

- `15 6 * * *` (06:15 UTC, 12:15 AM CST or 1:15 AM CDT), set in `wrangler.jsonc`. `scheduled()` in `src/index.ts` runs `runDueAssessmentInvoices`, which creates invoices for assessments whose open date has arrived and catches up a missed day. The job skips association id `assoc_seaside_demo`, so the sample ledger does not change. After those invoices are created, the same run emails each owner an invoice whose issue date has arrived, for associations that turned invoice emails on. That step also skips `assoc_seaside_demo`. A failed send is left unmarked and retries the next day. Invoices issued before the switch was turned on are not emailed. The same run writes `audit/payment-activity-YYYY-MM-DD.jsonl` to R2. That file is payment activity only. It does not include Stripe key values. A failure there does not stop invoicing. After that export, the same run adds automatic late fees for associations that turned them on. That step also skips `assoc_seaside_demo`. It does not change a late fee an admin already typed, and it does not add a second fee to an invoice that already has one.

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

## Online payments

Owners pay open invoices with Stripe Checkout (hosted page), ACH bank transfer only (`payment_method_types` is `us_bank_account`, Financial Connections instant verification, microdeposit fallback). Credit and debit cards are not accepted. Bank account numbers never touch this Worker. The invoice line is the ledger remainder (dues, late fees, and fee-schedule lines already on the invoice). A separate line, Bank transfer processing fee, is charged to the homeowner. The default is 0.8 percent, capped at $5.00. The board can change the percent, the cap, and the on/off switch under Payment settings. The fee is `min(cap, round up of subtotal / (1 - percent) - subtotal)`. It is stored on the checkout and on the payment and is not applied to invoices or balances. A mailed check has no processing fee.

Pay now is hidden until that neighborhood has payments turned on and a valid secret key. In test mode only an admin sees Pay now. Owners see it after a live key is saved. Pay now opens a list of that person's open invoices, all checked. They can uncheck any invoice to leave it for later. The invoice subtotal, the bank transfer processing fee, and the total update in the browser. The form sends the displayed fee with the checkout. The server recomputes the fee from the checked invoices. If the displayed fee is missing or does not match, checkout does not start and Pay now is shown again with a notice that the fee was updated. The chosen invoice list is stored on the checkout intent. `amount_cents` is the invoice subtotal. `fee_cents` is the processing fee. Stripe `amount_total` must equal the two added together. `allocation_json` sums to the subtotal only. The first payment row for that checkout stores the full fee. Later rows for the same checkout store a fee of 0, so the fee is not counted twice and is not part of a balance. A test-mode webhook (`livemode` false) records a payment labeled Test payment, not applied. It does not change the invoice status or the lot balance, and it cannot be edited. A live event is recorded only when the saved key is live, and that payment does apply. The demo association (`seaside`, code `100`) always shows Pay now. It opens the same invoice list, then a sample checkout that shows the fee, records nothing, and does not call Stripe.

Routes, on the internal `/a/<slug>` path and on the public vanity path (Tang-O-Mar: `https://myhoadashboard.com/tangomar/...`):

- `GET /admin/payment-settings` and the `POST` actions under it. Admin edit access only (the treasurer path). Board members without edit access do not see stored key material.
- `POST /pay` starts Checkout. `GET /pay/success` and `GET /pay/cancel` are the return pages.
- `POST /webhooks/stripe` is the Stripe webhook. Tang-O-Mar's URL is `https://myhoadashboard.com/tangomar/webhooks/stripe`.

Checkout metadata includes `neighborhood_id`, `lot`, and `invoice_ids` when that list fits in 500 characters. A longer list is left off the Stripe metadata. The full list stays on the checkout intent. The webhook requires the neighborhood id and checks the Checkout session id against that intent. If the metadata invoice list is blank or cut at 500 characters, the webhook uses the stored list. A shorter list that does not match is not recorded. Checkout sessions expire after 30 minutes. A repeat click in that window reuses the same Checkout session, so Cancel and Pay now again still opens Stripe. New sessions are limited to 10 per person per 10 minutes inside one database statement, so two clicks at the same moment cannot both slip past the limit. Return URLs are HTTPS except on localhost. Pages send `form-action 'self' https://checkout.stripe.com` so the browser can follow the redirect to Stripe.

The webhook checks the Stripe signature over the raw body. A failed check returns HTTP 400. The same 400 is used when the endpoint is not ready, so the response does not reveal whether a signing secret is stored. At most one rejected-signature activity row is written per neighborhood per minute. Further rejects are counted in the Worker log. A signed event is recorded only when `livemode` matches the saved key (`false` for test, `true` for live). A mismatch is ignored and written to the activity log. It does not change an invoice. If Stripe has the money but the ledger checks fail (unknown checkout, amount, or invoice list), the portal tells the board with "Online payment needs review" and still returns HTTP 200 so Stripe does not retry forever.

ACH does not settle inside the checkout. `checkout.session.completed` with `payment_status` unpaid marks the intent `processing` and applies nothing. The owner sees "Processing, usually 4 business days". `checkout.session.async_payment_succeeded` with `payment_status` paid credits the invoices for the subtotal only. `checkout.session.async_payment_failed` marks the intent failed and applies nothing. A failure that arrives after success does not undo the credit. The activity log asks the board to review it in Stripe. A processing intent blocks another online payment for those invoices for 14 days, counted from when the checkout was created. The 30 minute checkout window is only the Stripe page lifetime. After 14 days a processing intent no longer blocks Pay now. The board can clear a stuck processing transfer from Payment settings. That marks it abandoned and writes an activity row. Clearing does not credit an invoice. A later Stripe success can still record the payment. A processing or failed webhook does not change an abandoned checkout back to processing.

A recorded payment uses method `stripe` (shown as Online (Stripe)) and the Stripe payment id as the reference. The same Stripe event or payment id does not post twice. Admins cannot type a payment with that method, and they cannot edit or delete one. The owner gets a receipt from `EMAIL_FROM` (`donotreply@mytangomar.com`). The board notice uses the existing staff notice list.

`charge.refunded` reduces invoice credit and reopens the invoice when the net paid amount drops. `charge.dispute.created` does the same for the disputed amount. `charge.dispute.closed` with status `won` or `warning_closed` puts that amount back. A lost dispute stays off the balance. Stripe reports one total and does not label the processing fee. Refunds are applied fee-first. A refund of only the fee, at or below the stored fee, reverses nothing on the invoice. A full refund of subtotal plus fee reverses the subtotal only. A partial refund above the fee reverses the cents that remain after the fee. Cents already reversed are not reversed again. A dispute at or below the subtotal reduces invoice credit by that amount. Cents of a dispute above the subtotal are not posted to invoices. The board is notified in the portal for each of these. If two payments for one invoice are applied at the same moment, the extra is unapplied credit on the lot.

Payment settings use the same edit access as the rest of board admin: an officer, or a homeowner or board member with the admin flag. There is no separate treasurer flag.

Florida F.S. 501.171 controls in this feature: Stripe secrets are encrypted at rest with `PAYMENT_ENCRYPTION_KEY` and bound to the neighborhood; secret values are not logged, emailed, or returned to the browser; payment settings are limited to admin edit access; bank account numbers are not stored; credit and debit cards are not accepted; checkout links expire; payment pages and webhooks require HTTPS (localhost excepted for development); activity log entries cover each recorded payment, each settings change, each refund and dispute, and each failed webhook signature check. Those details do not include key values. The app cannot edit or delete an activity row, except clearing the actor when an account is deleted. A short breach notice plan for the board is in `docs/breach-notice.md`. It is not legal advice.

To rotate `PAYMENT_ENCRYPTION_KEY`:

1. Generate a new key with `openssl rand -base64 32`. Keep the old key.
2. Set `PAYMENT_ENCRYPTION_KEYS` to a JSON map that includes the old id and the new id. Set `PAYMENT_ENCRYPTION_KEY` to the new key and `PAYMENT_ENCRYPTION_KEY_ID` to the new id.
3. Put those secrets with `npx wrangler secret put`. Do not commit the values. Update the password-manager backup to the new key and keep the old key until step 5.
4. In each neighborhood, Board admin, Payment settings, choose Re-encrypt stored keys.
5. After every neighborhood ciphertext starts with `v2.<new id>.`, remove the old id from `PAYMENT_ENCRYPTION_KEYS`.

Treasurer steps, after `0019` and `0020` are applied and `PAYMENT_ENCRYPTION_KEY` is set:

1. In Stripe, open the HOA's own account (test mode first). Developers, API keys. Reveal the secret key (`sk_test_...` or, later, `sk_live_...`). Restricted keys (`rk_test_...` / `rk_live_...`) also work.
2. In the portal, Board admin, Ledger, Payment settings. Paste the secret key and choose Save. The page then shows Set, ending in, plus the last four characters, and Replace. It also shows Test mode or Live mode from the key prefix.
3. Copy the webhook URL shown on that page. For Tang-O-Mar it is `https://myhoadashboard.com/tangomar/webhooks/stripe`.
4. In Stripe, Developers, Webhooks, Add endpoint. Paste the URL. Select `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`, `charge.dispute.created`, and `charge.dispute.closed`.
5. Open the new endpoint and reveal the signing secret (`whsec_...`). Paste it into Webhook signing secret and choose Save.
6. Check Turn on Pay now and choose Save. The status line reads test mode, or live after a live key is saved. In test mode only an admin sees Pay now. After a live key is saved, owners see Pay now. Turn the checkbox off to hide Pay now again. Remove deletes the stored key and turns payments off.
7. Under Bank transfer processing fee, set the percent (default 0.8), the cap (default 5.00), and the on/off switch (default on). Choose Save fee. The activity log records the change. Apply `migrations/0022_bank_transfer_fee.sql` before this can be saved. Until then, checkout charges the invoice subtotal only.

## Late fees

Automatic late fees are off until an admin with edit access turns them on. Payment settings has a Late fees section on the same page. The ledger also links Late fees next to Payment settings for people with edit access. Board members without edit access cannot open or save that page.

Each association chooses a flat dollar amount or a percent of that invoice's unpaid balance, a wait of 1 to 365 days, and whether the wait starts on the invoice date (`issued_on`) or the due date (`due_on`). The fee is added once, on the morning the wait has elapsed. A 10 day wait from a due date of January 15 can be added on January 25. It is not added on January 24.

Florida F.S. 720.3085(3) caps the fee at the greater of $25 or 5% of the invoice amount. Five percent is rounded down to the cent. The daily job reduces a larger configured fee to that cap. A fee an admin already typed on the invoice is left as it is. The job also skips an invoice that has an open checkout (still inside its expiry) or a processing ACH checkout. A test-mode payment does not count as paid. The demo association can show sample settings (on, flat $25, 15 days from the due date) and the job does not change its ledger.

Waive late fee on the admin invoice page sets the fee to $0.00, records who and when in the activity log, and stops the job from adding it again. The owner invoice page shows a Late fee line when the amount is greater than zero. The balance already included that amount.

Paste `migrations/0023_late_fees.sql` after `0022`. That file adds `late_fee_settings` and the invoice columns `late_fee_applied_at`, `late_fee_waived_at`, and `late_fee_waived_by_user_id`. It inserts sample settings for `assoc_seaside_demo` only. It does not update any other association and it does not change existing invoice amounts. Deploy does not apply it.

## Invoice emails

Invoice emails are off until an admin with edit access turns them on under Payment settings. The help tip next to Invoice emails explains the switch. Board members without edit access cannot open or save that page.

When the switch is on, the daily job emails each owner their invoice on the date it is scheduled to go out, in the association time zone, with a link to view and pay. The message comes from `EMAIL_FROM`. An owner who turned off announcement emails still receives it. Each invoice is emailed once. Turning the switch off and on again moves the start date forward, so invoices issued while it was off are not emailed later. A failed send is not marked sent and retries the next day. The demo association never sends this email.

The admin invoice page shows Emailed and the date after a send. The activity log records the setting change, with the old and new value, and one row for each email that went out.

An admin with edit access can also choose Email this invoice on an issued invoice that still has a balance. That sends the same letter to the same owners, whether or not the daily switch is on. Paid, void, and not-yet-issued invoices stay disabled, with a short reason. The admin invoice page lists Email history for every send, newest first, in Central Time. An automatic send says Automatic and lists the owner emails. A resend says Resent, who clicked, and the owner emails. When nothing has been sent, it says Not emailed yet. Owners do not see this list. A second click within a minute is refused. This resend does not set `emailed_at`, so the daily job still sends on the issue date. The demo shows the button and, on click, says the demo does not send invoice email.

Paste `migrations/0024_invoice_emails.sql` after `0023`. That file adds `invoice_email_settings`, `invoice_email_events`, and the invoice column `emailed_at`. It does not email anyone and it does not change existing invoice amounts. Deploy does not apply it. Paste `migrations/0025_invoice_resend.sql` after `0024`. That file adds `invoice_resends` only. Deploy does not apply it. Paste `migrations/0026_invoice_resend_recipients.sql` after `0025`. That file adds `invoice_resend_recipients` only. Deploy does not apply it. Paste `migrations/0027_invoice_mail.sql` after `0026`. That file adds `invoice_mail_settings` and sample check details for the demo only. Deploy does not apply it. Until it is applied, invoice emails leave out the check box and the board note.

## Known gotchas

- D1 migrations are NOT applied by deploy. Each new `migrations/00NN_*.sql` is applied by hand (paste into the D1 console for database `tango`, or `npm run db:migrate:remote`) before the PR that needs it is merged. `migrations/0016_seed_seaside_demo.sql` is required for the public demo. Until it is applied, `/demo` says the demo is not ready and does not show Tang-O-Mar data. `migrations/0017_neighborhood_codes.sql` is required for neighborhood codes and `/tangomar`. Until it is applied, `/a/tango-mar` still works and email links stay on mytangomar.com. `migrations/0018_fee_schedule.sql` is required for the fee schedule. Until it is applied, Admin, Ledger shows the paste steps and dues stay one flat invoice per lot. `migrations/0019_online_payments.sql` is required before a treasurer can save Stripe keys. Until it is applied, owners see no Pay now button. The demo sample checkout does not need this migration. Two migration files share the number 0019 and both are already applied: `migrations/0019_demo_meeting_time.sql` and `migrations/0019_online_payments.sql`. Do not renumber them. `migrations/0020_payment_controls.sql` is required before refunds and disputes change balances and before the activity log rejects edits and deletes. `migrations/0021_test_payments.sql` is required before a test-mode payment can be stored. Until it is applied, a test-mode webhook is not recorded and does not mark an invoice paid. `migrations/0022_bank_transfer_fee.sql` is required before a processing fee is added and before a bank transfer can be marked processing, failed, or abandoned. Until it is applied, checkout charges the invoice subtotal only and an unpaid checkout completion cannot be tracked. `migrations/0023_late_fees.sql` is required before automatic late fees can be saved or added. Until it is applied, a late fee stays whatever an admin typed on the invoice, and the daily job adds none. The file turns the switch on only for Seaside Demo HOA. It does not change Tang-O-Mar or any other real association. `migrations/0024_invoice_emails.sql` is required before invoice emails can be turned on or sent. Until it is applied, invoice emails stay off. The file does not turn the switch on for any association. `migrations/0025_invoice_resend.sql` is required before Email this invoice can send. Until it is applied, that button asks for the migration and does not send. It does not change `emailed_at`. `migrations/0026_invoice_resend_recipients.sql` is required before Email history can list each owner a resend reached. Until it is applied, a resend still sends and the history shows how many owners it reached. `migrations/0027_invoice_mail.sql` is required before an admin can save the check mailing address and the board note. Until it is applied, invoice emails leave out the check box and the note. Apply `0019`, then `0020`, then `0021`, then `0022`, then `0023`, then `0024`, then `0025`, then `0026`, then `0027` before this code is deployed. Paste `0023`, `0024`, `0025`, `0026`, and `0027` once each in the D1 console for database `tango`. Deploy does not apply them.
- The cron list in `wrangler.jsonc` replaces any cron added in the dashboard on every deploy. Change schedules in the file, not the dashboard.
- Estoppel requests go to `ESTOPPEL_INBOX` in `src/lib/estoppel.ts` (marc@whpinc.com for now, to be changed later). The page links Florida Statute 720.30851.
- Demo requests go to `DEMO_INBOX` in `src/lib/demo-request.ts` (marc@whpinc.com).
- The estoppel rate limit (5 per IP per 10 minutes) lives in Worker memory, so a restart clears it.
- `EMAIL_FROM` must use a domain verified in Resend (mytangomar.com). Without `RESEND_API_KEY`, no mail goes out and production does not print magic links.
- Sample covenants and budget files are written into R2 the first time someone opens Documents. Replace them by uploading new versions.
- Uploads are limited to PDF, text, JPEG, PNG, WebP, and Word, up to 8 MB.

## Standing rule

Any PR that changes architecture (new secret, cron, storage, binding, or deploy change) must update this file in the same PR.
