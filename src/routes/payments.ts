import type { Hono } from "hono";
import { notifyStaff, writeAudit } from "../db";
import { isDemoAssociation } from "../lib/demo";
import { isMissingTable } from "../lib/errors";
import { canonicalPortalUrl } from "../lib/hosts";
import { invoiceEmailSettings, saveInvoiceEmailSetting } from "../lib/invoice-emails";
import { invoiceMailSettings, previewInvoiceEmail, saveInvoiceMailSettings } from "../lib/invoice-mail";
import { todayIso } from "../lib/dates";
import { BANK_TRANSFER_FEE_UPDATED, bankTransferFeeCents, parseDisplayedFeeCents } from "../lib/bank-fee";
import { describeLateFeeSettings, lateFeeSettingsView, saveLateFeeSettings } from "../lib/late-fees";
import { formatMoney } from "../lib/money";
import {
  abandonProcessingCheckout,
  applyStripeAdjustment,
  applyStripeCheckout,
  bankFeeConfig,
  checkoutReturnState,
  emailStripeReceipt,
  markCheckoutFailed,
  markCheckoutProcessing,
  markReceiptEmailed,
  payableInvoicesForUser,
  paymentSettingsView,
  paymentsReady,
  processingCheckoutsForAssociation,
  payOfferFor,
  reencryptPaymentSecrets,
  receiptRecipients,
  removeStripeSecret,
  removeWebhookSecret,
  saveBankTransferFee,
  saveStripeSecret,
  saveWebhookSecret,
  setPaymentsEnabled,
  startCheckout,
  webhookSecret,
  type PayableInvoice,
} from "../lib/online-payments";
import { canEditAdmin } from "../lib/access";
import { logError, logInfo } from "../lib/log";
import { redactSecrets, isSecurePaymentRequest, parseStripeEvent, verifyStripeSignature } from "../lib/stripe";
import type { AppBindings, Association } from "../types";
import { paymentSettingsPage } from "../views/admin";
import { render } from "../views/layout";
import { payCancelPage, paySelectPage, payStartPage, sampleCheckoutPage, paySuccessPage } from "../views/resident";
import { readForm, redirectTo, requireEditor, requireMember, textList, textValue } from "./common";

const MAX_WEBHOOK_BYTES = 262144;

export function registerPaymentRoutes(app: Hono<AppBindings>): void {
  app.get("/a/:slug/admin/payment-settings", async (c) => {
    const { association } = requireEditor(c);
    const [view, invoiceEmails] = await Promise.all([
      paymentSettingsView(c.env, c.env.DB, association.id),
      invoiceEmailSettings(c.env.DB, association.id),
    ]);
    return render(c, {
      title: `Payment settings · ${association.name}`,
      active: "admin",
      body: paymentSettingsPage({
        association,
        ...view,
        webhookUrl: canonicalPortalUrl(association, "/webhooks/stripe"),
        demo: isDemoAssociation(association),
        invoiceEmailsReady: invoiceEmails.ready,
        invoiceEmailsEnabled: invoiceEmails.enabled,
        invoiceEmailsEnabledOn: invoiceEmails.enabledOn,
        processing: await processingCheckoutsForAssociation(c.env.DB, association.id),
        lateFees: await lateFeeSettingsView(c.env.DB, association.id),
        mail: await invoiceMailSettings(c.env.DB, association.id),
      }),
    });
  });

  app.get("/a/:slug/admin/payment-settings/invoice-email-preview", async (c) => {
    const { association } = requireEditor(c);
    const letter = await previewInvoiceEmail(c.env.DB, association);
    return new Response(letter.html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });

  app.post("/a/:slug/admin/payment-settings/mailed-checks", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = `${settingsPath(association.slug)}#mailed-checks`;
    const saved = await saveInvoiceMailSettings(c.env.DB, association.id, {
      payableTo: textValue(fields, "payable_to", 200),
      mailingAddress: textValue(fields, "mailing_address", 500),
      boardNote: textValue(fields, "board_note", 400),
    });
    if (!saved.ok) return redirectTo(c, back, saved.message, "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "invoice_mail_settings",
      entityType: "invoice_mail_settings",
      entityId: association.id,
      detail: "Mailed check details saved.",
    });
    return redirectTo(c, back, "Mailed checks saved.");
  });

  app.post("/a/:slug/admin/payment-settings/secret", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = settingsPath(association.slug);
    const secret = textValue(fields, "secret_key", 200);
    if (!secret) return redirectTo(c, back, "Enter the Stripe secret key.", "warn");
    const saved = await saveStripeSecret(c.env, c.env.DB, association.id, user.id, secret);
    if (!saved.ok) return redirectTo(c, back, saved.message, "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: saved.action,
      entityType: "payment_settings",
      entityId: association.id,
      detail: saved.action === "payment_settings_secret_set"
        ? `Stripe secret key saved. Mode is ${saved.mode}.`
        : `Stripe secret key replaced. Mode is ${saved.mode}.`,
    });
    return redirectTo(c, back, saved.action === "payment_settings_secret_set" ? "Stripe secret key saved." : "Stripe secret key replaced.");
  });

  app.post("/a/:slug/admin/payment-settings/secret/remove", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = settingsPath(association.slug);
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, back, "Confirm the remove first.", "warn");
    const removed = await removeStripeSecret(c.env.DB, association.id, user.id);
    if (!removed.ok) return redirectTo(c, back, removed.message, "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "payment_settings_secret_removed",
      entityType: "payment_settings",
      entityId: association.id,
      detail: "Stripe secret key removed.",
    });
    if (removed.disabled) await auditDisabled(c, association.id, user.id, "Online payments turned off because the Stripe secret key was removed.");
    return redirectTo(c, back, "Stripe secret key removed.");
  });

  app.post("/a/:slug/admin/payment-settings/webhook", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = settingsPath(association.slug);
    const secret = textValue(fields, "webhook_secret", 200);
    if (!secret) return redirectTo(c, back, "Enter the webhook signing secret.", "warn");
    const saved = await saveWebhookSecret(c.env, c.env.DB, association.id, user.id, secret);
    if (!saved.ok) return redirectTo(c, back, saved.message, "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: saved.action,
      entityType: "payment_settings",
      entityId: association.id,
      detail: saved.action === "payment_settings_webhook_set" ? "Webhook signing secret saved." : "Webhook signing secret replaced.",
    });
    return redirectTo(c, back, saved.action === "payment_settings_webhook_set" ? "Webhook signing secret saved." : "Webhook signing secret replaced.");
  });

  app.post("/a/:slug/admin/payment-settings/webhook/remove", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = settingsPath(association.slug);
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, back, "Confirm the remove first.", "warn");
    const removed = await removeWebhookSecret(c.env.DB, association.id, user.id);
    if (!removed.ok) return redirectTo(c, back, removed.message, "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "payment_settings_webhook_removed",
      entityType: "payment_settings",
      entityId: association.id,
      detail: "Webhook signing secret removed.",
    });
    if (removed.disabled) await auditDisabled(c, association.id, user.id, "Online payments turned off because the webhook signing secret was removed.");
    return redirectTo(c, back, "Webhook signing secret removed.");
  });

  app.post("/a/:slug/admin/payment-settings/enabled", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = settingsPath(association.slug);
    const enabled = textValue(fields, "enabled", 5) === "yes";
    const saved = await setPaymentsEnabled(c.env, c.env.DB, association.id, user.id, enabled);
    if (!saved.ok) return redirectTo(c, back, saved.message, "warn");
    if (saved.changed) {
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: enabled ? "payment_settings_enabled" : "payment_settings_disabled",
        entityType: "payment_settings",
        entityId: association.id,
        detail: enabled ? "Online payments turned on." : "Online payments turned off.",
      });
    }
    if (!saved.changed) return redirectTo(c, back, "Payment settings saved.");
    return redirectTo(c, back, enabled ? "Online payments turned on." : "Online payments turned off.");
  });

  app.post("/a/:slug/admin/payment-settings/invoice-emails", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = settingsPath(association.slug);
    const enabled = textValue(fields, "invoice_emails", 5) === "yes";
    const saved = await saveInvoiceEmailSetting(c.env.DB, association.id, enabled, todayIso(association.timezone));
    if (!saved.ok) return redirectTo(c, back, saved.message, "warn");
    if (saved.changed) {
      const previous = saved.previousEnabled ? "on" : "off";
      const next = saved.enabled ? "on" : "off";
      const cutoff =
        saved.enabled && saved.enabledOn
          ? ` Invoices issued before ${saved.enabledOn} are not emailed.`
          : "";
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "invoice_emails_setting",
        entityType: "invoice_email_settings",
        entityId: association.id,
        detail: `Invoice emails changed from ${previous} to ${next}.${cutoff}`,
      });
    }
    if (!saved.changed) return redirectTo(c, back, "Payment settings saved.");
    return redirectTo(c, back, enabled ? "Invoice emails turned on." : "Invoice emails turned off.");
  });

  app.post("/a/:slug/admin/payment-settings/late-fees", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = `${settingsPath(association.slug)}#late-fees`;
    const saved = await saveLateFeeSettings(c.env.DB, association.id, user.id, {
      enabled: textValue(fields, "late_fee_enabled", 5) === "yes",
      feeType: textValue(fields, "fee_type", 20),
      flatAmount: textValue(fields, "flat_amount", 20),
      percent: textValue(fields, "percent", 20),
      days: textValue(fields, "days", 10),
      countFrom: textValue(fields, "count_from", 20),
    });
    if (!saved.ok) return redirectTo(c, back, saved.message, "warn");
    if (saved.changed) {
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "late_fee_settings",
        entityType: "late_fee_settings",
        entityId: association.id,
        detail: `Late fees changed from ${describeLateFeeSettings(saved.previous)} to ${describeLateFeeSettings(saved.next)}.`,
      });
    }
    return redirectTo(c, back, "Late fees saved.");
  });

  app.post("/a/:slug/admin/payment-settings/fee", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const back = settingsPath(association.slug);
    const enabled = textValue(fields, "fee_enabled", 5) === "yes";
    const saved = await saveBankTransferFee(
      c.env.DB,
      association.id,
      user.id,
      enabled,
      textValue(fields, "fee_percent", 20),
      textValue(fields, "fee_cap", 20),
    );
    if (!saved.ok) return redirectTo(c, back, saved.message, "warn");
    if (saved.changed) {
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "payment_settings_fee",
        entityType: "payment_settings",
        entityId: association.id,
        detail: `Bank transfer processing fee changed from ${saved.previousEnabled ? "on" : "off"}, ${saved.previousPercent}% capped at $${saved.previousCap} to ${saved.enabled ? "on" : "off"}, ${saved.percent}% capped at $${saved.cap}.`,
      });
    }
    return redirectTo(c, back, saved.changed ? "Bank transfer processing fee saved." : "Payment settings saved.");
  });

  app.post("/a/:slug/admin/payment-settings/processing/:intentId/abandon", async (c) => {
    const { association, user } = requireEditor(c);
    await readForm(c);
    const back = settingsPath(association.slug);
    const cleared = await abandonProcessingCheckout(c.env.DB, association.id, c.req.param("intentId"));
    if (!cleared.ok) return redirectTo(c, back, cleared.message, "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "payment_processing_abandoned",
      entityType: "checkout_intent",
      entityId: c.req.param("intentId"),
      detail: `Bank transfer marked abandoned. Nothing was applied to an invoice. Lot ${cleared.lotNumbers}. ${formatMoney(cleared.amountCents)}. ${c.req.param("intentId")}.`,
    });
    return redirectTo(c, back, "Stuck bank transfer cleared. Nothing was applied to an invoice.");
  });

  app.post("/a/:slug/admin/payment-settings/reencrypt", async (c) => {
    const { association, user } = requireEditor(c);
    await readForm(c);
    const back = settingsPath(association.slug);
    const saved = await reencryptPaymentSecrets(c.env, c.env.DB, association.id, user.id);
    if (!saved.ok) return redirectTo(c, back, saved.message, "warn");
    if (saved.changed) {
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "payment_settings_reencrypted",
        entityType: "payment_settings",
        entityId: association.id,
        detail: "Stored payment keys were re-encrypted with the current encryption key.",
      });
    }
    return redirectTo(c, back, saved.changed ? "Stored payment keys were re-encrypted." : "Stored payment keys already use the current encryption key.");
  });

  app.get("/a/:slug/pay", async (c) => {
    const { association, user, membership } = requireMember(c);
    const offer = await payOfferFor(c.env.DB, association, canEditAdmin(membership));
    if (offer.kind === "off") {
      return render(c, {
        title: "Pay",
        active: "dashboard",
        body: payStartPage(association),
      });
    }
    const open = await payableInvoicesForUser(c.env.DB, association.id, user.id, todayIso(association.timezone));
    const fee = await bankFeeConfig(c.env.DB, association.id);
    return render(c, {
      title: offer.kind === "demo" ? "Sample checkout" : "Pay now",
      active: "dashboard",
      body: paySelectPage({ association, invoices: open, offer, message: "", fee }),
    });
  });

  app.get("/a/:slug/pay/sample", async (c) => {
    const { association, user } = requireMember(c);
    if (!isDemoAssociation(association)) return c.redirect(`/a/${association.slug}/pay`, 303);
    const invoices = await selectDemoInvoices(c.env.DB, association, user.id, selectedInvoiceIds(c.req.queries("invoice_id"), c.req.query("invoice") ?? "", c.req.query("scope") ?? ""));
    if (invoices.length === 0) {
      const open = await payableInvoicesForUser(c.env.DB, association.id, user.id, todayIso(association.timezone));
      const fee = await bankFeeConfig(c.env.DB, association.id);
      return render(c, {
        title: "Sample checkout",
        active: "dashboard",
        body: paySelectPage({ association, invoices: open, offer: { kind: "demo" }, message: "Choose at least one invoice.", fee }),
      });
    }
    const params = new URLSearchParams();
    params.set("sample", "1");
    for (const invoice of invoices) params.append("invoice_id", invoice.invoiceId);
    const subtotal = invoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
    const fee = await bankFeeConfig(c.env.DB, association.id);
    const feeCents = bankTransferFeeCents(subtotal, fee) ?? 0;
    return render(c, {
      title: "Sample checkout",
      active: "dashboard",
      body: sampleCheckoutPage({
        association,
        invoices,
        successHref: `/a/${association.slug}/pay/success?${params.toString()}`,
        cancelHref: `/a/${association.slug}/pay/cancel?sample=1`,
        feeCents,
        fee,
      }),
    });
  });

  app.post("/a/:slug/pay", async (c) => {
    const { association, user, membership } = requireMember(c);
    if (isDemoAssociation(association)) return redirectTo(c, `/a/${association.slug}/dashboard`, "Demo only, changes are not saved", "warn");
    const fields = await readForm(c);
    const back = `/a/${association.slug}/pay`;
    const offer = await payOfferFor(c.env.DB, association, canEditAdmin(membership));
    if (offer.kind !== "stripe") return redirectTo(c, `/a/${association.slug}/dashboard`, "Online payment is not available.", "warn");
    if (!isSecurePaymentRequest(c.req.url)) return redirectTo(c, back, "Online payment has to start on a secure page.", "warn");
    const today = todayIso(association.timezone);
    const open = await payableInvoicesForUser(c.env.DB, association.id, user.id, today);
    const requested = new Set(textList(fields, "invoice_id", 80));
    const selected = open.filter((invoice) => requested.has(invoice.invoiceId));
    if (requested.size === 0 || selected.length === 0) return redirectTo(c, back, "Choose at least one invoice.", "warn");
    const fee = await bankFeeConfig(c.env.DB, association.id);
    const subtotal = selected.reduce((sum, invoice) => sum + invoice.amountCents, 0);
    const recomputed = bankTransferFeeCents(subtotal, fee);
    if (recomputed === null) {
      return redirectTo(c, back, "The bank transfer processing fee settings need to be corrected in Payment settings.", "warn");
    }
    const displayed = parseDisplayedFeeCents(textValue(fields, "fee_cents", 12));
    if (displayed === null || displayed !== recomputed) {
      return render(c, {
        title: "Pay now",
        active: "dashboard",
        body: paySelectPage({
          association,
          invoices: open,
          offer,
          message: BANK_TRANSFER_FEE_UPDATED,
          fee,
          checkedIds: selected.map((invoice) => invoice.invoiceId),
        }),
      });
    }
    const started = await startCheckout({
      env: c.env,
      db: c.env.DB,
      association,
      userId: user.id,
      email: user.email,
      requestUrl: c.req.url,
      invoices: selected,
    });
    if (!started.ok) return redirectTo(c, back, started.message, "warn");
    return c.redirect(started.url, 303);
  });

  app.get("/a/:slug/pay/success", async (c) => {
    const { association, user } = requireMember(c);
    const sample = c.req.query("sample") === "1" && isDemoAssociation(association);
    if (!sample) {
      const state = await checkoutReturnState(c.env.DB, association.id, user.id, c.req.query("session_id") ?? "");
      return render(c, { title: "Payment submitted", active: "dashboard", body: paySuccessPage({ association, sample: null, state }) });
    }
    const invoices = await selectDemoInvoices(c.env.DB, association, user.id, selectedInvoiceIds(c.req.queries("invoice_id"), c.req.query("invoice") ?? "", c.req.query("scope") ?? ""));
    const appliedCents = invoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
    const feeCents = bankTransferFeeCents(appliedCents, await bankFeeConfig(c.env.DB, association.id)) ?? 0;
    return render(c, {
      title: "Sample payment",
      active: "dashboard",
      body: paySuccessPage({
        association,
        sample: {
          invoices,
          appliedCents,
          feeCents,
          reference: "sample_pi_demo",
        },
      }),
    });
  });

  app.get("/a/:slug/pay/cancel", async (c) => {
    const { association } = requireMember(c);
    const sample = c.req.query("sample") === "1" && isDemoAssociation(association);
    return render(c, {
      title: "Payment canceled",
      active: "dashboard",
      body: payCancelPage(association, sample),
    });
  });

  app.post("/a/:slug/webhooks/stripe", async (c) => {
    const association = c.get("association");
    if (!association || isDemoAssociation(association)) return invalidWebhook();
    if (!isSecurePaymentRequest(c.req.url)) {
      await rejectWebhook(c, association.id, "Rejected insecure request.");
      return invalidWebhook();
    }
    let ready = false;
    try {
      ready = await paymentsReady(c.env.DB);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
    if (!ready) return invalidWebhook();
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      await rejectWebhook(c, association.id, "Webhook body was too large.");
      return invalidWebhook();
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_WEBHOOK_BYTES) {
      await rejectWebhook(c, association.id, "Webhook body was too large.");
      return invalidWebhook();
    }
    const secret = await webhookSecret(c.env, c.env.DB, association.id);
    if (!secret) {
      await rejectWebhook(c, association.id, "Webhook secret could not be read.");
      return invalidWebhook();
    }
    const verified = await verifyStripeSignature({
      secret,
      header: c.req.header("stripe-signature") ?? null,
      payload: bytes,
    });
    if (!verified.ok) {
      await rejectWebhook(c, association.id, `Stripe webhook signature rejected. Reason: ${verified.reason}.`);
      return invalidWebhook();
    }
    const payload = new TextDecoder().decode(bytes);
    const event = parseStripeEvent(payload);
    if (event === null) {
      await rejectWebhook(c, association.id, "Stripe webhook body could not be read. Payment was not recorded.");
      return c.json({ error: "unreadable" }, 400);
    }
    if (event.kind === "ignore") return c.json({ ok: true });
    if (event.kind === "processing" || event.kind === "checkout_failed") {
      try {
        const marked = event.kind === "processing"
          ? await markCheckoutProcessing({
              db: c.env.DB,
              association,
              livemode: event.livemode,
              eventId: event.eventId,
              sessionId: event.sessionId,
              amountTotal: event.amountTotal,
              clientReferenceId: event.clientReferenceId,
              neighborhoodId: event.neighborhoodId,
              userId: event.userId,
            })
          : await markCheckoutFailed({
              db: c.env.DB,
              association,
              livemode: event.livemode,
              eventId: event.eventId,
              sessionId: event.sessionId,
              amountTotal: event.amountTotal,
              clientReferenceId: event.clientReferenceId,
              neighborhoodId: event.neighborhoodId,
              userId: event.userId,
            });
        if (!marked.ok) await reviewWebhook(c, association, marked.detail, marked.review);
      } catch (error) {
        logError("payment_webhook", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
        return c.json({ error: "not recorded" }, 500);
      }
      return c.json({ ok: true });
    }
    if (event.kind === "refund" || event.kind === "dispute") {
      try {
        const adjusted = await applyStripeAdjustment({ db: c.env.DB, association, event });
        if (!adjusted.ok) await reviewWebhook(c, association, adjusted.detail, adjusted.review);
      } catch (error) {
        logError("payment_webhook", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
        return c.json({ error: "not recorded" }, 500);
      }
      return c.json({ ok: true });
    }
    let applied;
    try {
      applied = await applyStripeCheckout({
        db: c.env.DB,
        association,
        livemode: event.livemode,
        eventId: event.eventId,
        sessionId: event.sessionId,
        paymentId: event.paymentId,
        amountTotal: event.amountTotal,
        clientReferenceId: event.clientReferenceId,
        neighborhoodId: event.neighborhoodId,
        invoiceIds: event.invoiceIds,
        userId: event.userId,
      });
    } catch (error) {
      logError("payment_webhook", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
      return c.json({ error: "not recorded" }, 500);
    }
    if (!applied.ok) {
      await reviewWebhook(c, association, applied.detail, applied.review);
      return c.json({ ok: true });
    }
    if (!applied.applied.testOnly && !applied.applied.emailed) {
      const recipients = applied.applied.duplicate
        ? await receiptRecipients(c.env.DB, association.id, applied.applied.stripePaymentId)
        : applied.applied.ownerEmails;
      const sent = await emailStripeReceipt({
        env: c.env,
        db: c.env.DB,
        association,
        stripePaymentId: applied.applied.stripePaymentId,
        recipients,
      });
      if (sent) await markReceiptEmailed(c.env.DB, association.id, applied.applied.stripePaymentId);
      else if (!applied.applied.duplicate) {
        await writeAudit(c.env.DB, {
          associationId: association.id,
          actorUserId: null,
          action: "payment_receipt_email",
          entityType: "payment",
          entityId: applied.applied.paymentIds[0] ?? applied.applied.stripePaymentId,
          detail: `Receipt email was not sent. ${applied.applied.stripePaymentId}.`,
        });
      }
    }
    return c.json({ ok: true });
  });
}

function invalidWebhook(): Response {
  return Response.json({ error: "invalid request" }, { status: 400 });
}

const WEBHOOK_AUDIT_WINDOW_MS = 60 * 1000;

async function rejectWebhook(c: { env: Env }, associationId: string, detail: string): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - WEBHOOK_AUDIT_WINDOW_MS).toISOString();
    const recent = await c.env.DB
      .prepare(
        `SELECT id FROM audit_log
         WHERE association_id = ? AND action = 'payment_webhook_rejected' AND created_at >= ?
         LIMIT 1`,
      )
      .bind(associationId, cutoff)
      .first<{ id: string }>();
    if (recent) {
      logInfo("payment_webhook_rejected_suppressed", { associationId });
      return;
    }
    await writeAudit(c.env.DB, {
      associationId,
      actorUserId: null,
      action: "payment_webhook_rejected",
      entityType: "payment",
      entityId: "webhook",
      detail,
    });
  } catch (error) {
    logError("payment_webhook_audit", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
  }
}

async function reviewWebhook(
  c: { env: Env },
  association: Association,
  detail: string,
  review: boolean,
): Promise<void> {
  const action = review ? "payment_needs_review" : "payment_livemode_mismatch";
  try {
    if (!review) {
      const cutoff = new Date(Date.now() - WEBHOOK_AUDIT_WINDOW_MS).toISOString();
      const recent = await c.env.DB
        .prepare(
          `SELECT id FROM audit_log
           WHERE association_id = ? AND action = ? AND created_at >= ?
           LIMIT 1`,
        )
        .bind(association.id, action, cutoff)
        .first<{ id: string }>();
      if (recent) {
        logInfo("payment_webhook_rejected_suppressed", { associationId: association.id });
        return;
      }
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: null,
      action,
      entityType: "payment",
      entityId: "webhook",
      detail,
    });
    if (!review) return;
    await notifyStaff(c.env.DB, {
      associationId: association.id,
      kind: "account",
      title: "Online payment needs review",
      body: detail,
      href: `/a/${association.slug}/admin/ledger`,
    });
  } catch (error) {
    logError("payment_webhook_notice", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
  }
}

async function auditDisabled(c: { env: Env }, associationId: string, userId: string, detail: string): Promise<void> {
  await writeAudit(c.env.DB, {
    associationId,
    actorUserId: userId,
    action: "payment_settings_disabled",
    entityType: "payment_settings",
    entityId: associationId,
    detail,
  });
}

function settingsPath(slug: string): string {
  return `/a/${slug}/admin/payment-settings`;
}

function selectedInvoiceIds(listed: string[] | undefined, invoiceId: string, scope: string): string[] {
  if (scope === "balance") return ["*"];
  const ids = [...(listed ?? [])];
  if (invoiceId) ids.push(invoiceId);
  return ids;
}

async function selectDemoInvoices(
  db: D1Database,
  association: Association,
  userId: string,
  invoiceIds: string[],
): Promise<PayableInvoice[]> {
  const open = await payableInvoicesForUser(db, association.id, userId, todayIso(association.timezone));
  if (invoiceIds.includes("*")) return open;
  const wanted = new Set(invoiceIds);
  return open.filter((invoice) => wanted.has(invoice.invoiceId));
}

export function paymentsStatusForView(canEdit: boolean, slug: string, status: "not enabled" | "test mode" | "live"): {
  line: "not enabled" | "test mode" | "live";
  settingsHref: string | null;
} {
  return { line: status, settingsHref: canEdit ? `/a/${slug}/admin/payment-settings` : null };
}
