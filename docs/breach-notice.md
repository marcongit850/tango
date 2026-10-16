# Breach notice plan for the board

This note is for the Tang-O-Mar board and any other neighborhood that uses this portal. It is a plain-language checklist for Florida Statutes section 501.171. It is not legal advice. Ask the association attorney before you send a notice.

A breach here means someone got, or may have got, personal information the portal was not supposed to give them. That can include owner names, email addresses, lot numbers, invoice amounts, and payment history. The portal does not store bank account numbers. Online payments are ACH bank transfer only. Credit and debit cards are not accepted. Stripe hosts the bank page.

## Who to notify

1. Tell the board president and the person who holds the neighborhood Stripe account as soon as you know.
2. Tell each affected Florida resident. The statute gives 30 days after you determine a breach happened and identify who was affected.
3. If 500 or more Florida residents must be notified, also notify the Florida Department of Legal Affairs. That office is the Attorney General's office. Do this at the same time you notify those residents, or sooner if the attorney says so.
4. If Stripe keys may have been exposed, tell Stripe through the account holder and roll those keys. See "How to revoke Stripe keys" below.

Do not put secret keys, webhook secrets, or the encryption key in the notice, in email, or in the activity log.

## What to log

Write down, outside the public website:

- The date and time you discovered the problem, and who discovered it.
- What data was involved (names, emails, invoices, payment ids) and which neighborhood.
- Whether Stripe secret keys or the encryption key may have been read.
- Who you told, and the date and time of each notice (president, Stripe account holder, residents, Department of Legal Affairs if required).
- The date you rolled or removed the Stripe keys, and the date you rotated `PAYMENT_ENCRYPTION_KEY`.
- A copy of the payment activity export for the days around the event. The daily job writes `audit/payment-activity-YYYY-MM-DD.jsonl` in the documents bucket. You can also read rows in D1 table `audit_log` for the neighborhood. Do not edit or delete those rows. The database refuses updates and deletes, except clearing the actor when an account is deleted.

The portal activity log records payments, refunds, disputes, payment setting changes, and failed webhook signature checks. It never stores the key values.

## How to revoke Stripe keys

1. Sign in to the Stripe dashboard for the neighborhood account.
2. Roll the secret key (Developers, API keys). Roll the webhook signing secret too (Developers, Webhooks, the endpoint, Roll secret).
3. In the portal, Board admin, Payment settings, choose Remove on the secret key and on the webhook secret, or Replace them with the new values. Remove stops Pay now. In-flight checkouts cannot be recorded until a webhook secret is saved again.
4. In Stripe, delete or disable the old webhook endpoint if you created a new one.

## How to rotate the encryption key

Follow the steps named "To rotate `PAYMENT_ENCRYPTION_KEY`" in `ARCHITECTURE.md`. In short: generate a new key, keep the old key under its old id in `PAYMENT_ENCRYPTION_KEYS`, set the new key as `PAYMENT_ENCRYPTION_KEY`, then use Re-encrypt stored keys on each neighborhood's Payment settings page. After every neighborhood is re-encrypted, drop the old id from `PAYMENT_ENCRYPTION_KEYS`. Keep the backup in the board password manager only.

## How to pull the activity log

- Cloudflare dashboard, Workers and Pages, D1, database `tango`, Console. Example, for one neighborhood, read only:

  `SELECT created_at, action, entity_type, entity_id, detail FROM audit_log WHERE association_id = 'assoc_tangomar' ORDER BY created_at;`

- Or download the JSONL export from the documents bucket under `audit/payment-activity-`.

Replace the association id if the neighborhood is not Tang-O-Mar. Do not run `UPDATE` or `DELETE` on `audit_log`.
