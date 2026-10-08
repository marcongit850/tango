import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { canEditAdmin, canViewAdmin, canViewPropertyFinancials, isAdmin } from "../lib/access";
import { timeZoneLabel, todayIso } from "../lib/dates";
import { resendApiKey, sendResendEmail, SUPPORT_INBOX, supportEmailText } from "../lib/email";
import { ForbiddenError, isMissingColumn, isMissingTable, NotFoundError } from "../lib/errors";
import { logError, logInfo } from "../lib/log";
import { isValidEmail, normalizeEmail } from "../lib/homeowner-account";
import { ensureSeedFiles } from "../lib/seed-files";
import { sha256Hex } from "../lib/tokens";
import { issueEmailChangeLink } from "./auth";
import { applyDocumentResponseHeaders, contentTypeForUpload, deleteStoredFiles, MAX_MESSAGE_FILES, noticeFileProblem, safeFilename } from "../lib/files";
import {
  announcementEmailsOn,
  announcementPreferenceReady,
  consentLogReady,
  contactsForProperty,
  findSessionId,
  findUserByEmail,
  insertConsentLog,
  latestConsent,
  insertJoinRequest,
  invoiceById,
  joinRequestNoticeHref,
  lotsOwnedByUser,
  setAnnouncementEmails,
  invoicesForUser,
  ledgerForUser,
  listContacts,
  listDocuments,
  listEvents,
  listFaqs,
  noticeFileForUser,
  insertMessageAttachment,
  messageAttachmentsReady,
  messageFileKeysForMessage,
  messageFileKeysForThread,
  deleteMessage,
  deleteMessageThread,
  notificationsForUser,
  ownerIdsForProperty,
  paymentById,
  paymentsForUser,
  notifyStaff,
  propertyInAssociation,
  staffUserIds,
  threadMessages,
  threadsForViewer,
  type MessageRow,
  upcomingAssessments,
  versionById,
  visibleAnnouncements,
  writeAudit,
  notify,
} from "../db";
import type { AppBindings, Association, Membership } from "../types";
import { render } from "../views/layout";
import {
  boardPage,
  calendarPage,
  dashboardPage,
  documentsPage,
  propertyPage,
  faqPage,
  invoiceDetailPage,
  invoiceListPage,
  messagesPage,
  newsDetailPage,
  newsPage,
  noticesPage,
  paymentDetailPage,
  paymentListPage,
  profilePage,
  supportPage,
  threadPage,
} from "../views/resident";
import { fileValues, readForm, redirectTo, requireEditor, requireMember, streamMessageAttachment, textValue, type AppContext } from "./common";

const MESSAGE_FILES_UNAVAILABLE =
  "Apply the message file migration in D1, then try again. The steps are in the README under Message files.";

export function registerResidentRoutes(app: Hono<AppBindings>): void {
  app.get("/a/:slug/dashboard", async (c) => {
    const { association, user } = requireMember(c);
    const today = todayIso(association.timezone);
    const now = new Date().toISOString();
    const [ledger, upcoming, invoices, payments, notices, announcements, events] = await Promise.all([
      ledgerForUser(c.env.DB, association.id, user.id, today),
      upcomingAssessments(c.env.DB, association.id, user.id, today),
      invoicesForUser(c.env.DB, association.id, user.id, today),
      paymentsForUser(c.env.DB, association.id, user.id),
      notificationsForUser(c.env.DB, association.id, user.id),
      visibleAnnouncements(c.env.DB, association.id, now),
      listEvents(c.env.DB, association.id),
    ]);
    const nowMs = Date.now();
    const upcomingEvents = events.filter((event) => {
      const end = new Date(event.ends_at || event.starts_at).getTime();
      return Number.isFinite(end) && end >= nowMs;
    });
    return render(c, {
      title: `Dashboard · ${association.name}`,
      active: "dashboard",
      body: dashboardPage({
        association,
        name: user.name || user.email,
        ledger,
        upcoming,
        invoices,
        payments,
        notices,
        emergencies: announcements.filter((item) => item.kind === "emergency"),
        news: announcements.filter((item) => item.kind !== "emergency"),
        events: upcomingEvents,
        today,
      }),
    });
  });

  app.get("/a/:slug/profile", async (c) => {
    const { association, user } = requireMember(c);
    const lots = await lotsOwnedByUser(c.env.DB, association.id, user.id);
    const notices = await profileNotices(c.env.DB, association.id, user.id);
    return render(c, {
      title: `My profile · ${association.name}`,
      body: profilePage({
        association,
        name: user.name,
        email: user.email,
        phone: user.phone,
        lots,
        announcementsOn: notices.announcementsOn,
        consentGranted: notices.consentGranted,
        noticesReady: notices.ready,
      }),
    });
  });

  app.post("/a/:slug/profile", async (c) => {
    const { association, user } = requireMember(c);
    const fields = await readForm(c);
    const back = profilePath(association.slug);
    const name = textValue(fields, "name", 120);
    const phone = textValue(fields, "phone", 40);
    if (!name) return redirectTo(c, back, "Enter your name.", "warn");
    const nameChanged = name !== user.name;
    const phoneChanged = phone !== user.phone;
    if (!nameChanged && !phoneChanged) return redirectTo(c, back, "Name and phone saved.");
    await c.env.DB.prepare("UPDATE users SET name = ?, phone = ? WHERE id = ?").bind(name, phone, user.id).run();
    if (nameChanged) {
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "profile_name",
        entityType: "user",
        entityId: user.id,
        detail: `${user.name} to ${name}`,
      });
    }
    if (phoneChanged) {
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "profile_phone",
        entityType: "user",
        entityId: user.id,
        detail: `${user.phone} to ${phone}`,
      });
      await notifyStaff(c.env.DB, {
        associationId: association.id,
        kind: "profile",
        title: "Phone number updated",
        body: `${name} updated their phone.`,
        href: `/a/${association.slug}/admin/owners/${user.id}`,
      });
    }
    return redirectTo(c, back, "Name and phone saved.");
  });

  app.post("/a/:slug/profile/notices", async (c) => {
    const { association, user } = requireMember(c);
    const fields = await readForm(c);
    const back = profilePath(association.slug);
    const ready = (await announcementPreferenceReady(c.env.DB)) && (await consentLogReady(c.env.DB));
    if (!ready) {
      return redirectTo(
        c,
        back,
        "Apply the email preferences migration in D1, then try again. The steps are in the README under Email preferences.",
        "warn",
      );
    }
    const wantAnnouncements = fields.email_announcements === "1";
    const wantConsent = fields.electronic_consent === "1";
    const [announcementsOn, current] = await Promise.all([
      announcementEmailsOn(c.env.DB, user.id),
      latestConsent(c.env.DB, association.id, user.id),
    ]);
    const consentGranted = current?.action === "granted";
    if (wantAnnouncements === announcementsOn && wantConsent === consentGranted) {
      return redirectTo(c, back, "Email preferences saved.");
    }
    const lots = await lotsOwnedByUser(c.env.DB, association.id, user.id);
    const lotList = lots.map((lot) => lot.lot_number).filter(Boolean).join(", ");
    const context = await noticeRequestContext(c);
    if (wantAnnouncements !== announcementsOn) {
      await setAnnouncementEmails(c.env.DB, user.id, wantAnnouncements);
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "profile_announcements",
        entityType: "user",
        entityId: user.id,
        detail: wantAnnouncements ? "On" : "Off",
      });
    }
    if (wantConsent !== consentGranted) {
      await insertConsentLog(c.env.DB, {
        associationId: association.id,
        userId: user.id,
        ownerName: user.name,
        lots: lotList,
        email: user.email,
        action: wantConsent ? "granted" : "revoked",
        ip: context.ip,
        userAgent: context.userAgent,
        sessionId: context.sessionId,
      });
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: wantConsent ? "consent_granted" : "consent_revoked",
        entityType: "user",
        entityId: user.id,
        detail: user.email,
      });
    }
    return redirectTo(c, back, "Email preferences saved.");
  });

  app.post("/a/:slug/profile/email", async (c) => {
    const { association, user } = requireMember(c);
    const fields = await readForm(c);
    const back = profilePath(association.slug);
    const email = normalizeEmail(textValue(fields, "email", 200));
    if (!isValidEmail(email) || email.length > 200) return redirectTo(c, back, "Enter a valid email.", "warn");
    if (email === user.email.trim().toLowerCase()) return redirectTo(c, back, "That is already your email.");
    const taken = await findUserByEmail(c.env.DB, email);
    if (taken && taken.id !== user.id) return redirectTo(c, back, "That email is already used.", "warn");
    const devLink = await issueEmailChangeLink(c, {
      userId: user.id,
      newEmail: email,
      associationId: association.id,
      associationName: association.name,
    });
    if (devLink) {
      const [lots, notices] = await Promise.all([
        lotsOwnedByUser(c.env.DB, association.id, user.id),
        profileNotices(c.env.DB, association.id, user.id),
      ]);
      return render(c, {
        title: `My profile · ${association.name}`,
        body: profilePage({
          association,
          name: user.name,
          email: user.email,
          phone: user.phone,
          lots,
          devLink,
          announcementsOn: notices.announcementsOn,
          consentGranted: notices.consentGranted,
          noticesReady: notices.ready,
        }),
      });
    }
    return redirectTo(c, back, "Check the new email. Your login changes after you open the link.");
  });

  app.post("/a/:slug/profile/lots/:propertyId", async (c) => {
    const { association, user } = requireMember(c);
    const fields = await readForm(c);
    const back = profilePath(association.slug);
    const propertyId = c.req.param("propertyId");
    const lots = await lotsOwnedByUser(c.env.DB, association.id, user.id);
    const lot = lots.find((row) => row.id === propertyId);
    if (!lot) return redirectTo(c, back, "Choose one of your lots.", "warn");
    const mailing = {
      street: textValue(fields, "mailing_street", 200),
      city: textValue(fields, "mailing_city", 80),
      state: textValue(fields, "mailing_state", 40),
      postal: textValue(fields, "mailing_postal_code", 20),
    };
    const unchanged =
      mailing.street === lot.mailing_street &&
      mailing.city === lot.mailing_city &&
      mailing.state === lot.mailing_state &&
      mailing.postal === lot.mailing_postal_code;
    if (unchanged) return redirectTo(c, back, "Mailing address saved.");
    try {
      const updated = await c.env.DB
        .prepare(
          `UPDATE properties
           SET mailing_street = ?, mailing_city = ?, mailing_state = ?, mailing_postal_code = ?
           WHERE association_id = ? AND id = ?
             AND EXISTS (
               SELECT 1 FROM property_owners po
               WHERE po.association_id = properties.association_id
                 AND po.property_id = properties.id
                 AND po.user_id = ?
             )`,
        )
        .bind(mailing.street, mailing.city, mailing.state, mailing.postal, association.id, propertyId, user.id)
        .run();
      if ((updated.meta.changes ?? 0) === 0) return redirectTo(c, back, "Choose one of your lots.", "warn");
    } catch (error) {
      if (isMissingColumn(error)) {
        return redirectTo(c, back, "Apply the lot details migration in D1, then try again. The steps are in the README under Lot details.", "warn");
      }
      throw error;
    }
    const label = user.name || user.email;
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "profile_mailing",
      entityType: "property",
      entityId: propertyId,
      detail: `${label} updated the mailing address for lot ${lot.lot_number}.`,
    });
    await notifyStaff(c.env.DB, {
      associationId: association.id,
      kind: "profile",
      title: "Mailing address updated",
      body: `${label} updated the mailing address for lot ${lot.lot_number}.`,
      href: `/a/${association.slug}/admin/ledger/${propertyId}`,
    });
    return redirectTo(c, back, "Mailing address saved.");
  });

  app.post("/a/:slug/profile/owner", async (c) => {
    const { association, user } = requireMember(c);
    const fields = await readForm(c);
    const back = profilePath(association.slug);
    const name = textValue(fields, "name", 120);
    const email = normalizeEmail(textValue(fields, "email", 200));
    const propertyId = textValue(fields, "property_id", 80);
    if (!name || !isValidEmail(email)) return redirectTo(c, back, "Enter a name and a valid email.", "warn");
    if (email === user.email.trim().toLowerCase()) return redirectTo(c, back, "Use a different email. This form does not change your login.", "warn");
    const lots = await lotsOwnedByUser(c.env.DB, association.id, user.id);
    const lot = lots.find((row) => row.id === propertyId);
    if (!lot) return redirectTo(c, back, "Choose one of your lots.", "warn");
    const contacts = await contactsForProperty(c.env.DB, association.id, lot.id);
    if (contacts.some((contact) => contact.email.trim().toLowerCase() === email)) {
      return redirectTo(c, back, "That person is already an owner of this lot.", "warn");
    }
    const requester = user.name || user.email;
    const note = `${requester} asked to add this person as another owner of lot ${lot.lot_number}.`;
    try {
      const pending = await c.env.DB
        .prepare(
          `SELECT id FROM join_requests
           WHERE association_id = ? AND property_id = ? AND email = ? AND status IN ('pending', 'reviewed')`,
        )
        .bind(association.id, lot.id, email)
        .first<{ id: string }>();
      if (pending) return redirectTo(c, back, "A request for that email is already waiting.", "warn");
      const id = await insertJoinRequest(c.env.DB, {
        associationId: association.id,
        name,
        email,
        address: `Lot ${lot.lot_number}`,
        note,
        propertyId: lot.id,
      });
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "co_owner_request",
        entityType: "join_request",
        entityId: id,
        detail: `${requester} asked to add ${name} (${email}) on lot ${lot.lot_number}.`,
      });
      await notifyStaff(c.env.DB, {
        associationId: association.id,
        kind: "join_request",
        title: `Second owner request for lot ${lot.lot_number}`,
        body: email,
        href: joinRequestNoticeHref(association.slug, id),
      });
      logInfo("co_owner_request", { associationId: association.id });
    } catch (error) {
      if (isMissingColumn(error) || isMissingTable(error)) {
        return redirectTo(
          c,
          back,
          "Apply the co-owner request migration in D1, then try again. The steps are in the README under My profile.",
          "warn",
        );
      }
      throw error;
    }
    return redirectTo(c, back, "Request sent. The board will review it.");
  });

  app.get("/a/:slug/lots/:propertyId", async (c) => {
    const { association, user, membership } = requireMember(c);
    const property = await propertyInAssociation(c.env.DB, association.id, c.req.param("propertyId"));
    if (!property) throw new NotFoundError();
    const ownerIds = await ownerIdsForProperty(c.env.DB, association.id, property.id);
    if (!canViewPropertyFinancials(membership, user.id, ownerIds)) throw new ForbiddenError();
    const contacts = await contactsForProperty(c.env.DB, association.id, property.id);
    return render(c, {
      title: `Lot ${property.lot_number}`,
      active: "dashboard",
      body: propertyPage({
        association,
        lotNumber: property.lot_number,
        houseName: property.house_name,
        streetAddress: property.street_address,
        city: property.city,
        state: property.state,
        postalCode: property.postal_code,
        mailingStreet: property.mailing_street,
        mailingCity: property.mailing_city,
        mailingState: property.mailing_state,
        mailingPostalCode: property.mailing_postal_code,
        contacts: contacts.map((contact) => ({
          name: contact.name,
          phone: contact.phone,
          isPrimary: Number(contact.is_primary) === 1,
        })),
      }),
    });
  });

  app.get("/a/:slug/invoices", async (c) => {
    const { association, user } = requireMember(c);
    const invoices = await invoicesForUser(c.env.DB, association.id, user.id, todayIso(association.timezone));
    return render(c, { title: "Invoices", active: "dashboard", body: invoiceListPage(association, invoices) });
  });

  app.get("/a/:slug/invoices/:invoiceId", async (c) => {
    const { association } = requireMember(c);
    const invoice = await invoiceById(c.env.DB, association.id, c.req.param("invoiceId"));
    if (!invoice) throw new NotFoundError();
    await assertPropertyAccess(c, association.id, invoice.property_id);
    return render(c, {
      title: invoice.invoice_number,
      active: "dashboard",
      body: invoiceDetailPage(association, invoice, todayIso(association.timezone)),
    });
  });

  app.get("/a/:slug/payments", async (c) => {
    const { association, user } = requireMember(c);
    const payments = await paymentsForUser(c.env.DB, association.id, user.id);
    return render(c, { title: "Payments", active: "dashboard", body: paymentListPage(association, payments) });
  });

  app.get("/a/:slug/payments/:paymentId", async (c) => {
    const { association } = requireMember(c);
    const payment = await paymentById(c.env.DB, association.id, c.req.param("paymentId"));
    if (!payment) throw new NotFoundError();
    await assertPropertyAccess(c, association.id, payment.property_id);
    return render(c, { title: "Receipt", active: "dashboard", body: paymentDetailPage(association, payment) });
  });

  app.get("/a/:slug/notices", async (c) => {
    const { association, user } = requireMember(c);
    const notices = await notificationsForUser(c.env.DB, association.id, user.id);
    return render(c, { title: "Notices from the Board", active: "notices", body: noticesPage(association, notices) });
  });

  app.post("/a/:slug/notices/read-all", async (c) => {
    const { association, user } = requireMember(c);
    await readForm(c);
    await c.env.DB
      .prepare("UPDATE notifications SET read_at = ? WHERE association_id = ? AND user_id = ? AND read_at IS NULL")
      .bind(new Date().toISOString(), association.id, user.id)
      .run();
    return redirectTo(c, `/a/${association.slug}/notices`, "Notices from the Board marked read.");
  });

  app.get("/a/:slug/notices/:noticeId/file", async (c) => {
    const { association, user } = requireMember(c);
    const file = await noticeFileForUser(c.env.DB, association.id, user.id, c.req.param("noticeId"));
    if (!file) throw new NotFoundError();
    const object = await c.env.DOCUMENTS.get(file.r2_key);
    if (!object) throw new NotFoundError();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    applyDocumentResponseHeaders(headers, {
      filename: file.filename,
      contentType: file.content_type,
      download: c.req.query("download") === "1",
    });
    return new Response(object.body, { headers });
  });

  app.post("/a/:slug/notices/:noticeId/read", async (c) => {
    const { association, user } = requireMember(c);
    await readForm(c);
    await c.env.DB
      .prepare("UPDATE notifications SET read_at = ? WHERE association_id = ? AND user_id = ? AND id = ?")
      .bind(new Date().toISOString(), association.id, user.id, c.req.param("noticeId"))
      .run();
    return redirectTo(c, `/a/${association.slug}/notices`);
  });

  app.get("/a/:slug/documents", async (c) => {
    const { association, membership } = requireMember(c);
    await ensureSeedFiles(c.env.DOCUMENTS, c.env.DB);
    const documents = await listDocuments(c.env.DB, association.id, canViewAdmin(membership));
    return render(c, { title: "Documents", active: "documents", body: documentsPage(association, documents) });
  });

  app.get("/a/:slug/documents/:documentId/file", async (c) => {
    const { association, membership } = requireMember(c);
    return streamCurrent(c, association, membership, c.req.param("documentId"));
  });

  app.get("/a/:slug/news", async (c) => {
    const { association } = requireMember(c);
    const items = await visibleAnnouncements(c.env.DB, association.id, new Date().toISOString());
    return render(c, { title: "News", active: "news", body: newsPage(association, items) });
  });

  app.get("/a/:slug/news/:announcementId", async (c) => {
    const { association } = requireMember(c);
    const items = await visibleAnnouncements(c.env.DB, association.id, new Date().toISOString());
    const item = items.find((entry) => entry.id === c.req.param("announcementId"));
    if (!item) throw new NotFoundError();
    return render(c, { title: item.title, active: "news", body: newsDetailPage(association, item) });
  });

  app.get("/a/:slug/calendar", async (c) => {
    const { association } = requireMember(c);
    const events = await listEvents(c.env.DB, association.id);
    return render(c, {
      title: "Calendar",
      active: "calendar",
      body: calendarPage(association, events, timeZoneLabel(association.timezone)),
    });
  });

  app.get("/a/:slug/faq", async (c) => {
    const { association } = requireMember(c);
    const faqs = await listFaqs(c.env.DB, association.id);
    return render(c, { title: "FAQ", active: "faq", body: faqPage(faqs) });
  });

  app.get("/a/:slug/board", async (c) => {
    const { association, membership } = requireMember(c);
    const contacts = await listContacts(c.env.DB, association.id);
    return render(c, {
      title: "Board",
      active: "board",
      body: boardPage(association, contacts, { canEdit: canEditAdmin(membership) }),
    });
  });

  app.post("/a/:slug/board", async (c) => {
    const { association, user } = requireEditor(c);
    const fields = await readForm(c);
    const draft = {
      legal_name: textValue(fields, "legal_name", 200),
      address_line1: textValue(fields, "address_line1", 200),
      city: textValue(fields, "city", 80),
      state: textValue(fields, "state", 40),
      postal_code: textValue(fields, "postal_code", 20),
    };
    if (!draft.legal_name) {
      const contacts = await listContacts(c.env.DB, association.id);
      return render(c, {
        title: "Board",
        active: "board",
        status: 400,
        body: boardPage(association, contacts, {
          canEdit: true,
          open: true,
          error: "Enter the legal name.",
          draft,
        }),
      });
    }
    await c.env.DB
      .prepare(
        `UPDATE associations
         SET legal_name = ?, address_line1 = ?, city = ?, state = ?, postal_code = ?
         WHERE id = ?`,
      )
      .bind(draft.legal_name, draft.address_line1, draft.city, draft.state, draft.postal_code, association.id)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "mailing_update",
      entityType: "association",
      entityId: association.id,
      detail: [draft.legal_name, draft.address_line1, draft.city, draft.state, draft.postal_code].filter(Boolean).join(", "),
    });
    return redirectTo(c, `/a/${association.slug}/board`, "Mailing address saved.");
  });

  app.get("/a/:slug/support", async (c) => {
    const { association, user } = requireMember(c);
    return render(c, {
      title: "Support",
      active: "support",
      body: supportPage(association, user),
    });
  });

  app.post("/a/:slug/support", async (c) => {
    const { association, user } = requireMember(c);
    const fields = await readForm(c);
    const message = textValue(fields, "body", 5000);
    if (!message) {
      return render(c, {
        title: "Support",
        active: "support",
        status: 400,
        body: supportPage(association, user, "", "Write a message before sending."),
      });
    }
    const name = user.name.replace(/[\r\n]+/g, " ").trim();
    const email = user.email.replace(/[\r\n]+/g, "").trim();
    const apiKey = resendApiKey(c.env);
    let sent = false;
    if (apiKey) {
      try {
        sent = await sendResendEmail({
          apiKey,
          from: c.env.EMAIL_FROM,
          to: SUPPORT_INBOX,
          replyTo: email,
          subject: `Support message from ${name || email}`.slice(0, 200),
          text: supportEmailText({ name, email, message }),
        });
      } catch (error) {
        logError("support_email", { message: error instanceof Error ? error.message : "unknown" });
      }
    } else {
      logError("support_email", { message: "email not configured" });
    }
    if (!sent) {
      return render(c, {
        title: "Support",
        active: "support",
        status: 503,
        body: supportPage(association, user, message, "Your message could not be sent. Please try again later."),
      });
    }
    logInfo("support_email", { associationId: association.id, userId: user.id });
    return redirectTo(c, `/a/${association.slug}/support`, "Your message was sent.");
  });

  app.get("/a/:slug/messages", async (c) => {
    const { association, user } = requireMember(c);
    const [threads, properties] = await Promise.all([
      threadsForViewer(c.env.DB, association.id, user.id, false),
      ownedProperties(c, association.id, user.id),
    ]);
    return render(c, {
      title: "Messages",
      active: "messages",
      body: messagesPage(
        association,
        threads,
        properties.map((property) => ({ id: property.id, lot_number: property.lot_number })),
      ),
    });
  });

  app.post("/a/:slug/messages", async (c) => {
    const { association, user, membership } = requireMember(c);
    const fields = await readForm(c);
    const subject = textValue(fields, "subject", 200);
    const body = textValue(fields, "body", 5000);
    const propertyId = textValue(fields, "property_id", 80);
    const listPath = `/a/${association.slug}/messages`;
    if (!subject || !body) return redirectTo(c, listPath, "Add a subject and a message.", "warn");
    if (propertyId) {
      const property = await propertyInAssociation(c.env.DB, association.id, propertyId);
      if (!property) throw new NotFoundError();
      if (!isAdmin(membership)) await assertPropertyAccess(c, association.id, propertyId);
    }
    const uploads = fileValues(fields, "file");
    if (uploads.length > MAX_MESSAGE_FILES) return redirectTo(c, listPath, "Attach up to 3 files.", "warn");
    for (const upload of uploads) {
      const problem = noticeFileProblem(upload);
      if (problem) return redirectTo(c, listPath, problem, "warn");
    }
    if (uploads.length > 0 && !(await messageAttachmentsReady(c.env.DB))) {
      return redirectTo(c, listPath, MESSAGE_FILES_UNAVAILABLE, "warn");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await c.env.DB
      .prepare(
        `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(id, association.id, id, user.id, propertyId || null, subject, body, now)
      .run();
    const stored: string[] = [];
    const filenames: string[] = [];
    try {
      for (const [index, upload] of uploads.entries()) {
        const attachmentId = crypto.randomUUID();
        const filename = safeFilename(upload.name);
        const contentType = contentTypeForUpload(upload);
        if (!contentType) throw new Error("file type");
        const bytes = new Uint8Array(await upload.arrayBuffer());
        const r2Key = `${association.id}/messages/${id}/${attachmentId}/${filename}`;
        await c.env.DOCUMENTS.put(r2Key, bytes, { httpMetadata: { contentType } });
        stored.push(r2Key);
        await insertMessageAttachment(c.env.DB, {
          id: attachmentId,
          associationId: association.id,
          messageId: id,
          filename,
          contentType,
          r2Key,
          byteSize: bytes.byteLength,
          createdAt: new Date(Date.parse(now) + index).toISOString(),
        });
        filenames.push(filename);
      }
    } catch (error) {
      await deleteStoredFiles(c.env.DOCUMENTS, stored);
      await c.env.DB.prepare("DELETE FROM messages WHERE association_id = ? AND id = ?").bind(association.id, id).run();
      if (isMissingTable(error)) return redirectTo(c, listPath, MESSAGE_FILES_UNAVAILABLE, "warn");
      throw error;
    }
    const staff = await staffUserIds(c.env.DB, association.id);
    for (const staffId of staff) {
      if (staffId === user.id) continue;
      await notify(c.env.DB, {
        associationId: association.id,
        userId: staffId,
        kind: "message",
        title: `New message from ${user.name || user.email}`,
        body: subject,
        href: `/a/${association.slug}/admin/messages/${id}`,
      });
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "message_create",
      entityType: "message",
      entityId: id,
      detail: filenames.join(", "),
    });
    return redirectTo(c, `/a/${association.slug}/messages/${id}`, "Message sent to the board.");
  });

  app.get("/a/:slug/messages/:threadId/messages/:messageId/file/:attachmentId", async (c) => {
    const { membership } = requireMember(c);
    return streamMessageAttachment(
      c,
      c.req.param("threadId"),
      c.req.param("messageId"),
      c.req.param("attachmentId"),
      canViewAdmin(membership),
    );
  });

  app.get("/a/:slug/messages/:threadId", async (c) => {
    const { association, user, membership } = requireMember(c);
    const messages = await loadThread(c, association.id, c.req.param("threadId"));
    return render(c, {
      title: messages[0].subject,
      active: "messages",
      body: threadPage(association, messages[0].subject, messages, {
        allowThreadDelete: isAdmin(membership) || userStartedThread(messages, user.id),
        replyDelete: isAdmin(membership) ? "all" : "own",
        viewerUserId: user.id,
      }),
    });
  });

  app.post("/a/:slug/messages/:threadId/reply", async (c) => {
    const { association, user, membership } = requireMember(c);
    const fields = await readForm(c);
    const body = textValue(fields, "body", 5000);
    const threadId = c.req.param("threadId");
    const messages = await loadThread(c, association.id, threadId);
    if (!body) return redirectTo(c, `/a/${association.slug}/messages/${threadId}`, "Write a reply before sending.", "warn");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await c.env.DB
      .prepare(
        `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, association.id, threadId, messages.at(-1)?.id ?? threadId, user.id, messages[0].property_id, messages[0].subject, body, now)
      .run();
    const recipients = new Set<string>();
    const next = textValue(fields, "next", 200);
    if (isAdmin(membership)) {
      for (const message of messages) recipients.add(message.from_user_id);
    } else {
      for (const staffId of await staffUserIds(c.env.DB, association.id)) recipients.add(staffId);
    }
    recipients.delete(user.id);
    for (const recipient of recipients) {
      await notify(c.env.DB, {
        associationId: association.id,
        userId: recipient,
        kind: "message",
        title: `Reply from ${user.name || user.email}`,
        body: messages[0].subject,
        href: isAdmin(membership) ? `/a/${association.slug}/messages/${threadId}` : `/a/${association.slug}/admin/messages/${threadId}`,
      });
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "message_reply",
      entityType: "message",
      entityId: id,
    });
    const back = next.startsWith(`/a/${association.slug}/admin/messages/`) ? next : `/a/${association.slug}/messages/${threadId}`;
    return redirectTo(c, back, "Reply sent.");
  });

  app.post("/a/:slug/messages/:threadId/delete", async (c) => {
    const { association, user, membership } = requireMember(c);
    const fields = await readForm(c);
    const threadId = c.req.param("threadId");
    const list = `/a/${association.slug}/messages`;
    const threadPath = `${list}/${threadId}`;
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, threadPath, "Confirm the delete first.", "warn");
    const messages = await threadMessages(c.env.DB, association.id, threadId);
    if (messages.length === 0) return redirectTo(c, list, "That thread is already gone.", "warn");
    if (!isAdmin(membership) && !messages.some((message) => message.from_user_id === user.id)) throw new ForbiddenError();
    if (!isAdmin(membership) && !userStartedThread(messages, user.id)) {
      return redirectTo(c, threadPath, "You can delete a thread you started.", "warn");
    }
    const fileKeys = await messageFileKeysForThread(c.env.DB, association.id, threadId);
    const removed = await deleteMessageThread(c.env.DB, association.id, association.slug, threadId);
    if (removed) await deleteStoredFiles(c.env.DOCUMENTS, fileKeys);
    if (!removed) return redirectTo(c, list, "That thread is already gone.", "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "message_thread_delete",
      entityType: "message",
      entityId: threadId,
      detail: messages[0].subject,
    });
    return redirectTo(c, list, "Message thread deleted.");
  });

  app.post("/a/:slug/messages/:threadId/messages/:messageId/delete", async (c) => {
    const { association, user, membership } = requireMember(c);
    const fields = await readForm(c);
    const threadId = c.req.param("threadId");
    const messageId = c.req.param("messageId");
    const list = `/a/${association.slug}/messages`;
    const threadPath = `${list}/${threadId}`;
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, threadPath, "Confirm the delete first.", "warn");
    const messages = await threadMessages(c.env.DB, association.id, threadId);
    if (messages.length === 0) return redirectTo(c, list, "That reply is already gone.", "warn");
    if (!isAdmin(membership) && !messages.some((message) => message.from_user_id === user.id)) throw new ForbiddenError();
    const target = messages.find((message) => message.id === messageId);
    if (!target) return redirectTo(c, threadPath, "That reply is already gone.", "warn");
    if (!isAdmin(membership) && target.from_user_id !== user.id) {
      return redirectTo(c, threadPath, "You can delete your own reply.", "warn");
    }
    const ownRemaining = messages.filter((message) => message.from_user_id === user.id && message.id !== messageId).length;
    if (!isAdmin(membership) && ownRemaining === 0 && messages.length > 1) {
      return redirectTo(c, threadPath, "Delete the thread to remove the conversation.", "warn");
    }
    const fileKeys = await messageFileKeysForMessage(c.env.DB, association.id, messageId);
    const removed = await deleteMessage(c.env.DB, association.id, association.slug, threadId, messageId);
    if (removed) await deleteStoredFiles(c.env.DOCUMENTS, fileKeys);
    if (!removed) return redirectTo(c, threadPath, "That reply is already gone.", "warn");
    const remaining = await threadMessages(c.env.DB, association.id, threadId);
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: remaining.length === 0 ? "message_thread_delete" : "message_delete",
      entityType: "message",
      entityId: remaining.length === 0 ? threadId : messageId,
      detail: target.subject,
    });
    if (remaining.length === 0) return redirectTo(c, list, "Message thread deleted.");
    return redirectTo(c, threadPath, "Reply deleted.");
  });
}

async function assertPropertyAccess(c: AppContext, associationId: string, propertyId: string): Promise<void> {
  const { user, membership } = requireMember(c);
  const property = await propertyInAssociation(c.env.DB, associationId, propertyId);
  if (!property) throw new NotFoundError();
  const owners = await ownerIdsForProperty(c.env.DB, associationId, propertyId);
  if (!canViewPropertyFinancials(membership, user.id, owners)) throw new ForbiddenError();
}

function profilePath(slug: string): string {
  return `/a/${slug}/profile`;
}

async function profileNotices(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<{ announcementsOn: boolean; consentGranted: boolean; ready: boolean }> {
  const [announcementsReady, consentReady, announcementsOn, current] = await Promise.all([
    announcementPreferenceReady(db),
    consentLogReady(db),
    announcementEmailsOn(db, userId),
    latestConsent(db, associationId, userId),
  ]);
  return {
    announcementsOn,
    consentGranted: current?.action === "granted",
    ready: announcementsReady && consentReady,
  };
}

async function noticeRequestContext(c: AppContext): Promise<{ ip: string; userAgent: string; sessionId: string }> {
  const token = getCookie(c, "tango_session");
  const sessionId = token ? await findSessionId(c.env.DB, await sha256Hex(token)) : "";
  return {
    ip: (c.req.header("cf-connecting-ip") ?? "").trim().slice(0, 80),
    userAgent: (c.req.header("user-agent") ?? "").trim().slice(0, 400),
    sessionId,
  };
}

async function ownedProperties(c: AppContext, associationId: string, userId: string) {
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.id, p.lot_number, p.street_address, p.city, p.state, p.postal_code, p.status
       FROM properties p
       JOIN property_owners po ON po.property_id = p.id AND po.association_id = p.association_id
       WHERE p.association_id = ? AND po.user_id = ?
       ORDER BY p.lot_number`,
    )
    .bind(associationId, userId)
    .all<{ id: string; lot_number: string; street_address: string; city: string; state: string; postal_code: string; status: string }>();
  return results;
}

function userStartedThread(messages: MessageRow[], userId: string): boolean {
  const threadId = messages[0]?.thread_id ?? "";
  if (messages.some((message) => message.id === threadId && message.from_user_id === userId)) return true;
  const root = messages.find((message) => message.parent_id === null);
  return root?.from_user_id === userId;
}

async function loadThread(c: AppContext, associationId: string, threadId: string) {
  const { user, membership } = requireMember(c);
  const messages = await threadMessages(c.env.DB, associationId, threadId);
  if (messages.length === 0) throw new NotFoundError();
  if (!isAdmin(membership) && !messages.some((message) => message.from_user_id === user.id)) {
    throw new ForbiddenError();
  }
  return messages;
}

async function streamCurrent(c: AppContext, association: Association, membership: Membership, documentId: string): Promise<Response> {
  const document = await c.env.DB
    .prepare("SELECT id, visibility, current_version_id FROM documents WHERE association_id = ? AND id = ?")
    .bind(association.id, documentId)
    .first<{ id: string; visibility: "residents" | "board"; current_version_id: string | null }>();
  if (!document?.current_version_id) throw new NotFoundError();
  if (document.visibility === "board" && !canViewAdmin(membership)) throw new ForbiddenError();
  const version = await versionById(c.env.DB, association.id, document.current_version_id);
  if (!version || version.document_id !== document.id) throw new NotFoundError();
  await ensureSeedFiles(c.env.DOCUMENTS, c.env.DB);
  const object = await c.env.DOCUMENTS.get(version.r2_key);
  if (!object) throw new NotFoundError();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  applyDocumentResponseHeaders(headers, {
    filename: version.filename,
    contentType: version.content_type,
    download: c.req.query("download") === "1",
  });
  return new Response(object.body, { headers });
}
