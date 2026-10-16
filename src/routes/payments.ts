import type { Hono } from "hono";
import { writeAudit } from "../db";
import { isDemoAssociation } from "../lib/demo";
import { isMissingTable } from "../lib/errors";
import { canonicalPortalUrl } from "../lib/hosts";
import { todayIso } from "../lib/dates";
import {
  applyStripeCheckout,
  emailStripeReceipt,
  markReceiptEmailed,
  payableInvoicesForUser,
  paymentSettingsView,
  paymentsReady,
  payOfferFor,
  receiptRecipients,
  removeStripeSecret,
  removeWebhookSecret,
  saveStripeSecret,
  saveWebhookSecret,
  setPaymentsEnabled,
  startCheckout,
  webhookSecret,
  type PayableInvoice,
} from "../lib/online-payments";
import { logError } from "../lib/log";
import { redactSecrets, isSecurePaymentRequest, parseCheckoutEvent, verifyStripeSignature } from "../lib/stripe";
import type { AppBindings, Association } from "../types";
import { paymentSettingsPage } from "../views/admin";
import { render } from "../views/layout";
import { payCancelPage, payStartPage, sampleCheckoutPage, paySuccessPage } from "../views/resident";
import { readForm, redirectTo, requireEditor, requireMember, textValue } from "./common";

const MAX_WEBHOOK_BYTES = 262144;

export function registerPaymentRoutes(app: Hono<AppBindings>): void {
  app.get("/a/:slug/admin/payment-settings", async (c) => {
    const { association } = requireEditor(c);
    const view = await paymentSettingsView(c.env, c.env.DB, association.id);
    return render(c, {
      title: `Payment settings · ${association.name}`,
      active: "admin",
      body: paymentSettingsPage({
        association,
        ...view,
        webhookUrl: canonicalPortalUrl(association, "/webhooks/stripe"),
        demo: isDemoAssociation(association),
      }),
    });
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

  app.get("/a/:slug/pay", async (c) => {
    const { association, user } = requireMember(c);
    if (!isDemoAssociation(association)) {
      return render(c, {
        title: "Pay",
        active: "dashboard",
        body: payStartPage(association),
      });
    }
    const invoices = await selectDemoInvoices(c.env.DB, association, user.id, c.req.query("invoice") ?? "", c.req.query("scope") ?? "");
    if (invoices.length === 0) {
      return render(c, {
        title: "Sample checkout",
        active: "dashboard",
        body: sampleCheckoutPage({ association, invoices: [], successHref: "", cancelHref: `/a/${association.slug}/dashboard` }),
      });
    }
    const params = new URLSearchParams();
    params.set("sample", "1");
    if (c.req.query("invoice")) params.set("invoice", c.req.query("invoice") ?? "");
    if (c.req.query("scope") === "balance") params.set("scope", "balance");
    return render(c, {
      title: "Sample checkout",
      active: "dashboard",
      body: sampleCheckoutPage({
        association,
        invoices,
        successHref: `/a/${association.slug}/pay/success?${params.toString()}`,
        cancelHref: `/a/${association.slug}/pay/cancel?sample=1`,
      }),
    });
  });

  app.post("/a/:slug/pay", async (c) => {
    const { association, user } = requireMember(c);
    if (isDemoAssociation(association)) return redirectTo(c, `/a/${association.slug}/dashboard`, "Demo only, changes are not saved", "warn");
    const fields = await readForm(c);
    const back = `/a/${association.slug}/dashboard`;
    const offer = await payOfferFor(c.env.DB, association);
    if (offer.kind !== "stripe") return redirectTo(c, back, "Online payment is not available.", "warn");
    if (!isSecurePaymentRequest(c.req.url)) return redirectTo(c, back, "Online payment has to start on a secure page.", "warn");
    const today = todayIso(association.timezone);
    const open = await payableInvoicesForUser(c.env.DB, association.id, user.id, today);
    const invoiceId = textValue(fields, "invoice_id", 80);
    const selected = invoiceId ? open.filter((invoice) => invoice.invoiceId === invoiceId) : textValue(fields, "scope", 20) === "balance" ? open : [];
    if (selected.length === 0) return redirectTo(c, back, "Nothing is due on that invoice.", "warn");
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
      return render(c, { title: "Payment submitted", active: "dashboard", body: paySuccessPage({ association, sample: null }) });
    }
    const invoices = await selectDemoInvoices(c.env.DB, association, user.id, c.req.query("invoice") ?? "", c.req.query("scope") ?? "");
    const appliedCents = invoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
    return render(c, {
      title: "Sample payment",
      active: "dashboard",
      body: paySuccessPage({
        association,
        sample: {
          invoices,
          appliedCents,
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
    if (!association || isDemoAssociation(association)) return c.json({ error: "not found" }, 404);
    if (!isSecurePaymentRequest(c.req.url)) {
      await rejectWebhook(c, association.id, "Rejected insecure request.");
      return c.json({ error: "https required" }, 400);
    }
    let ready = false;
    try {
      ready = await paymentsReady(c.env.DB);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
    if (!ready) return c.json({ error: "not found" }, 404);
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      await rejectWebhook(c, association.id, "Webhook body was too large.");
      return c.json({ error: "payload too large" }, 413);
    }
    const payload = await c.req.text();
    if (payload.length > MAX_WEBHOOK_BYTES) {
      await rejectWebhook(c, association.id, "Webhook body was too large.");
      return c.json({ error: "payload too large" }, 413);
    }
    const secret = await webhookSecret(c.env, c.env.DB, association.id);
    if (!secret) {
      const view = await paymentSettingsView(c.env, c.env.DB, association.id);
      if (!view.webhookLast4) return c.json({ error: "not found" }, 404);
      await rejectWebhook(c, association.id, "Webhook secret could not be read.");
      return c.json({ error: "not ready" }, 500);
    }
    const verified = await verifyStripeSignature({
      secret,
      header: c.req.header("stripe-signature") ?? null,
      payload,
    });
    if (!verified.ok) {
      await rejectWebhook(c, association.id, `Stripe webhook signature rejected. Reason: ${verified.reason}.`);
      return c.json({ error: "invalid signature" }, 400);
    }
    const event = parseCheckoutEvent(payload);
    if (event === null) {
      await rejectWebhook(c, association.id, "Stripe webhook body could not be read. Payment was not recorded.");
      return c.json({ error: "unreadable" }, 400);
    }
    if (event === "ignore") return c.json({ ok: true });
    let applied;
    try {
      applied = await applyStripeCheckout({
        db: c.env.DB,
        association,
        eventId: event.eventId,
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
      await rejectWebhook(c, association.id, applied.detail);
      return c.json({ ok: true });
    }
    if (!applied.applied.emailed) {
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

async function rejectWebhook(c: { env: Env }, associationId: string, detail: string): Promise<void> {
  try {
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

async function selectDemoInvoices(
  db: D1Database,
  association: Association,
  userId: string,
  invoiceId: string,
  scope: string,
): Promise<PayableInvoice[]> {
  const open = await payableInvoicesForUser(db, association.id, userId, todayIso(association.timezone));
  if (scope === "balance") return open;
  if (!invoiceId) return [];
  return open.filter((invoice) => invoice.invoiceId === invoiceId);
}

export function paymentsStatusForView(canEdit: boolean, slug: string, status: "not enabled" | "test mode" | "live"): {
  line: "not enabled" | "test mode" | "live";
  settingsHref: string | null;
} {
  return { line: status, settingsHref: canEdit ? `/a/${slug}/admin/payment-settings` : null };
}
