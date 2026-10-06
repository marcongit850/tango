import { describe, expect, it } from "vitest";
import { canViewPropertyFinancials, isAdmin, keepsAnAdmin, safeNextPath, shouldRevealMagicLink } from "../src/lib/access";
import { annualDues, defaultDuesYear, lotsToInvoice } from "../src/lib/dues";
import { landingAccount, loggedOutNav } from "../src/views/layout";
import { documentDetailPage, newsAdminPage, ownerDetailPage } from "../src/views/admin";
import { newsEdit } from "../src/routes/admin";
import type { AnnouncementRow, DocumentRow, EventRow, VersionRow } from "../src/db";
import { documentContentDisposition, isBrowserViewable } from "../src/lib/files";
import { documentsPage, faqPage } from "../src/views/resident";
import { checkEmailPage, homePage, invalidLinkPage, joinReceivedPage, joinRequestPage, loginPage } from "../src/views/public";
import type { OwnerListRow } from "../src/db";
import type { Association } from "../src/types";
import { parseCsv, parseOwnersCsv } from "../src/lib/csv";
import { isIsoDate, todayIso, utcToDatetimeLocal, zonedLocalToUtc } from "../src/lib/dates";
import { balanceCents, csvText, formatMoney, invoiceStatus, isDelinquent, parseMoneyToCents } from "../src/lib/money";
import { sha256Hex } from "../src/lib/tokens";

describe("money", () => {
  it("parses dollar amounts from a spreadsheet", () => {
    expect(parseMoneyToCents("375.50")).toBe(37550);
    expect(parseMoneyToCents("$1,200.00")).toBe(120000);
    expect(parseMoneyToCents("(40.00)")).toBe(-4000);
    expect(parseMoneyToCents("-15")).toBe(-1500);
    expect(parseMoneyToCents("")).toBe(0);
    expect(parseMoneyToCents("12.345")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
  });

  it("formats cents and computes a balance", () => {
    expect(formatMoney(160050)).toBe("$1,600.50");
    expect(formatMoney(-250)).toBe("-$2.50");
    expect(balanceCents(160050, 0)).toBe(160050);
    expect(isDelinquent(160050, true)).toBe(true);
    expect(isDelinquent(0, true)).toBe(false);
    expect(isDelinquent(100, false)).toBe(false);
  });

  it("derives invoice status from payments on that invoice", () => {
    expect(invoiceStatus(120000, 0, 0)).toBe("open");
    expect(invoiceStatus(120000, 0, 1000)).toBe("partial");
    expect(invoiceStatus(120000, 2500, 122500)).toBe("paid");
  });

  it("keeps spreadsheet formulas from running in exported text", () => {
    expect(csvText("=cmd")).toBe("'=cmd");
    expect(csvText('Lot "14"')).toBe('"Lot ""14"""');
  });
});

describe("owner csv", () => {
  it("reads quoted commas and defaults the role", () => {
    const csv = [
      "email,name,lot_number,street_address,role,starting_balance,balance_as_of,phone",
      'a@example.com,"Rivera, Sam",14,"Lot 14, Tang O Mar Drive",homeowner,$375.50,2026-01-15,850-555-0142',
      "b@example.com,Jordan Lee,3,Lot 3 Tang O Mar Drive,,,,",
    ].join("\n");
    const parsed = parseOwnersCsv(csv, { city: "Miramar Beach", state: "FL", postalCode: "32550", today: "2026-10-06" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      email: "a@example.com",
      name: "Rivera, Sam",
      streetAddress: "Lot 14, Tang O Mar Drive",
      startingBalanceCents: 37550,
      balanceAsOf: "2026-01-15",
      city: "Miramar Beach",
    });
    expect(parsed.rows[1]).toMatchObject({ role: "homeowner", isAdmin: null, startingBalanceCents: 0, balanceAsOf: "2026-10-06" });
  });

  it("maps officer to board with admin and rejects admin on a homeowner", () => {
    const csv = [
      "email,name,lot_number,street_address,role,admin",
      "a@example.com,Jordan,3,Street,officer,",
      "b@example.com,Quinn,4,Street,board,no",
      "c@example.com,Sam,5,Street,homeowner,yes",
    ].join("\n");
    const parsed = parseOwnersCsv(csv, { city: "Miramar Beach", state: "FL", postalCode: "32550", today: "2026-10-06" });
    expect(parsed.rows.map((row) => ({ email: row.email, role: row.role, isAdmin: row.isAdmin }))).toEqual([
      { email: "a@example.com", role: "board", isAdmin: true },
      { email: "b@example.com", role: "board", isAdmin: false },
    ]);
    expect(parsed.errors[0].message).toMatch(/Admin access is only for board members/);
  });

  it("reports a missing column and a bad role", () => {
    expect(parseOwnersCsv("email,name\n", { city: "", state: "", postalCode: "", today: "2026-10-06" }).errors[0].message).toMatch(/lot_number/);
    const bad = parseOwnersCsv("email,name,lot_number,street_address,role\na@example.com,A,1,Street,mayor\n", {
      city: "Miramar Beach",
      state: "FL",
      postalCode: "32550",
      today: "2026-10-06",
    });
    expect(bad.rows).toHaveLength(0);
    expect(bad.errors[0].message).toMatch(/Role/);
  });

  it("keeps quoted line breaks inside a cell", () => {
    const rows = parseCsv('email,name\n"a@example.com","Line one\nLine two"\n');
    expect(rows[1][1]).toBe("Line one\nLine two");
  });
});

describe("access", () => {
  it("hides another resident's ledger and shows it to an admin", () => {
    expect(canViewPropertyFinancials({ role_id: "homeowner", is_admin: 0 }, "user_sam", ["user_casey"])).toBe(false);
    expect(canViewPropertyFinancials({ role_id: "homeowner", is_admin: 0 }, "user_sam", ["user_sam"])).toBe(true);
    expect(canViewPropertyFinancials({ role_id: "board", is_admin: 1 }, "user_quinn", ["user_sam"])).toBe(true);
    expect(canViewPropertyFinancials({ role_id: "board", is_admin: 0 }, "user_quinn", [])).toBe(false);
    expect(canViewPropertyFinancials({ role_id: "board", is_admin: 0 }, "user_quinn", ["user_quinn"])).toBe(true);
    expect(canViewPropertyFinancials({ role_id: "officer" }, "user_jordan", [])).toBe(true);
    expect(canViewPropertyFinancials(null, "visitor", ["user_sam"])).toBe(false);
    expect(isAdmin({ role_id: "homeowner", is_admin: 0 })).toBe(false);
    expect(isAdmin({ role_id: "board", is_admin: 1 })).toBe(true);
    expect(isAdmin({ role_id: "board", is_admin: 0 })).toBe(false);
    expect(isAdmin({ role_id: "officer" })).toBe(true);
    expect(isAdmin({ role_id: "board", is_admin: 1, status: "inactive" })).toBe(false);
    expect(keepsAnAdmin({ activeAdminCount: 1, currentlyAdmin: true, nextAdmin: false })).toBe(false);
    expect(keepsAnAdmin({ activeAdminCount: 2, currentlyAdmin: true, nextAdmin: false })).toBe(true);
    expect(keepsAnAdmin({ activeAdminCount: 1, currentlyAdmin: true, nextAdmin: true })).toBe(true);
  });

  it("shows magic links only for local development when email was not sent", () => {
    expect(shouldRevealMagicLink({ appEnv: "production", hostname: "tango.example", emailSent: false })).toBe(false);
    expect(shouldRevealMagicLink({ appEnv: "production", hostname: "localhost", emailSent: false })).toBe(true);
    expect(shouldRevealMagicLink({ appEnv: "development", hostname: "tango.example", emailSent: false })).toBe(true);
    expect(shouldRevealMagicLink({ appEnv: "development", hostname: "localhost", emailSent: true })).toBe(false);
  });

  it("rejects open redirects", () => {
    expect(safeNextPath("tango-mar", "/a/tango-mar/documents")).toBe("/a/tango-mar/documents");
    expect(safeNextPath("tango-mar", "https://evil.example")).toBe("/a/tango-mar/dashboard");
    expect(safeNextPath("tango-mar", "/a/other/dashboard")).toBe("/a/tango-mar/dashboard");
  });
});

describe("dates", () => {
  it("converts Miramar Beach local time to UTC", () => {
    expect(isIsoDate("2026-02-31")).toBe(false);
    expect(isIsoDate("2026-11-08")).toBe(true);
    expect(zonedLocalToUtc("2026-11-08T10:00", "America/Chicago")).toBe("2026-11-08T16:00:00.000Z");
    expect(zonedLocalToUtc("2026-10-18T09:00", "America/Chicago")).toBe("2026-10-18T14:00:00.000Z");
    expect(todayIso("America/Chicago", new Date("2026-10-06T15:00:00Z"))).toBe("2026-10-06");
    expect(utcToDatetimeLocal("2026-11-08T16:00:00.000Z", "America/Chicago")).toBe("2026-11-08T10:00");
  });
});

describe("annual dues", () => {
  it("opens January 1, is due March 1, and prices lots by type", () => {
    expect(annualDues(2027, "improved")).toMatchObject({
      amountCents: 62500,
      opensOn: "2027-01-01",
      dueOn: "2027-03-01",
      lotType: "improved",
    });
    expect(annualDues(2027, "unimproved").amountCents).toBe(10000);
    expect(defaultDuesYear("2026-10-06")).toBe(2027);
    expect(defaultDuesYear("2027-02-01")).toBe(2027);
    const plan = lotsToInvoice(
      [
        { id: "a", lotNumber: "3", status: "active", lotType: "improved" },
        { id: "b", lotNumber: "4", status: "active", lotType: "unimproved" },
        { id: "c", lotNumber: "5", status: "inactive", lotType: "improved" },
        { id: "d", lotNumber: "6", status: "active", lotType: "improved" },
      ],
      "improved",
      new Set(["d"]),
    );
    expect(plan.create.map((lot) => lot.lotNumber)).toEqual(["3"]);
    expect(plan.already).toBe(1);
  });
});

describe("logged-out header", () => {
  it("uses Resident login and Request to join on home, login, and join", () => {
    for (const active of ["home", "login", "join"]) {
      expect(loggedOutNav(active)).toEqual([
        { id: "login", href: "/login", label: "Resident login" },
        { id: "join", href: "/join", label: "Request to join" },
      ]);
    }
  });

  it("keeps a Home link on other public pages", () => {
    expect(loggedOutNav("legal").map((item) => item.label)).toEqual(["Home", "Resident login", "Request to join"]);
    expect(loggedOutNav().some((item) => item.label === "Neighborhood" || item.label === "Log in")).toBe(false);
  });
});

describe("public home", () => {
  it("offers resident login and request to join", () => {
    const html = homePage(false);
    expect(html).toContain("Resident login");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("/a/tango-mar/login");
    expect(html).toContain("Request access");
    expect(html).toContain('href="/join"');
    expect(html).toContain("Welcome to Tango Mar");
    expect(html).toContain("A private beach neighborhood in Miramar Beach, Walton County, Florida.");
    expect(html).toContain("Your neighborhood portal for association information, documents, announcements, account details, and community resources.");
    expect(html).toContain('src="/tango-mar-boardwalk.png"');
    expect(html).toContain('src="/tango-mar-mark.png"');
    expect(html).not.toContain('src="/favicon.png"');
    expect(html).toContain("Property Owners Association");
    expect(html).not.toContain("Welcome to your neighborhood dashboard");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("Open portal");
    expect(html).not.toContain("Enter Tango Mar");
    expect(html).not.toContain("Associations");
    expect(html).not.toContain("/legal");
    expect(html).not.toContain("Local demo roster");
  });

  it("confirms a join request without creating a login", () => {
    const html = joinReceivedPage();
    expect(html).toContain("Your message has been sent to the Board. A Board member will follow up with you by email.");
    expect(html).toContain("Submitting this form does not create a homeowner login or account.");
    expect(html).not.toContain("The board has your note");
  });

  it("uses Marc's sign-in and magic-link copy", () => {
    const association: Association = {
      id: "assoc_tango_mar",
      slug: "tango-mar",
      name: "Tango Mar",
      legal_name: "Tango Mar Property Owners Association",
      address_line1: "31 Tang O Mar Drive",
      city: "Miramar Beach",
      state: "FL",
      postal_code: "32550",
      county: "Walton County",
      timezone: "America/Chicago",
    };
    const login = loginPage(association, "/a/tango-mar/dashboard");
    expect(login).toContain("Sign in to Tango Mar Dashboard");
    expect(login).toContain(
      "Enter the email address associated with your association account. We'll send you a secure, one-time login link. No password required.",
    );
    expect(login).not.toContain("There is no password.");
    expect(login).toContain('action="/login"');
    expect(invalidLinkPage()).toContain('href="/login"');
    const check = checkEmailPage(association.name, null);
    expect(check).toContain(
      "If your email is on the Tango Mar roster, your secure sign-in link is on the way. The link expires in 20 minutes and can only be used once. After you sign in, you’ll stay logged in on this device for up to 30 days.",
    );
    expect(check).not.toContain("a sign-in link is on its way");
  });

  it("shows the fictional roster only for the local demo", () => {
    expect(homePage(true)).toContain("jordan.lee@example.com");
  });

  it("sends a signed-in homeowner into the dashboard", () => {
    const html = homePage(false, { dashboardHref: "/a/tango-mar/dashboard", adminHref: null });
    expect(html).toContain("Open dashboard");
    expect(html).toContain('href="/a/tango-mar/dashboard"');
    expect(html).not.toContain(">Admin<");
    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain('href="/join"');
    expect(html).not.toContain("\u2014");
  });

  it("offers Admin as well when the signed-in person has admin access", () => {
    const html = homePage(false, { dashboardHref: "/a/tango-mar/dashboard", adminHref: "/a/tango-mar/admin" });
    expect(html).toContain('href="/a/tango-mar/dashboard"');
    expect(html).toContain('href="/a/tango-mar/admin"');
    expect(html).toContain("Open dashboard");
    expect(html).toContain(">Admin<");
  });

  it("keeps the name and log out beside the portal buttons", () => {
    const homeowner = landingAccount("Sam Rivera", { dashboardHref: "/a/tango-mar/dashboard", adminHref: null });
    expect(homeowner).toContain("Sam Rivera");
    expect(homeowner).toContain("Log out");
    expect(homeowner).toContain('href="/a/tango-mar/dashboard"');
    expect(homeowner).not.toContain('href="/a/tango-mar/admin"');
    const admin = landingAccount("Jordan Lee", { dashboardHref: "/a/tango-mar/dashboard", adminHref: "/a/tango-mar/admin" });
    expect(admin).toContain("Jordan Lee");
    expect(admin).toContain('href="/a/tango-mar/admin"');
    expect(admin).toContain("Log out");
  });

  it("lets an admin edit the login email on the owner page", () => {
    const owner: OwnerListRow = {
      user_id: "user_sam",
      email: "sam.rivera@example.com",
      name: "Sam Rivera",
      phone: "",
      role_id: "homeowner",
      is_admin: 0,
      status: "active",
      property_id: "prop_14",
      lot_number: "14",
      street_address: "Lot 14",
    };
    const association: Association = {
      id: "assoc_tango_mar",
      slug: "tango-mar",
      name: "Tango Mar",
      legal_name: "Tango Mar Property Owners Association",
      address_line1: "31 Tang O Mar Drive",
      city: "Miramar Beach",
      state: "FL",
      postal_code: "32550",
      county: "Walton County",
      timezone: "America/Chicago",
    };
    const html = ownerDetailPage({ association, owner, balance: 0, lots: [], properties: [] });
    expect(html).toContain('action="/a/tango-mar/admin/owners/user_sam/email"');
    expect(html).toContain('value="sam.rivera@example.com"');
    expect(html).toContain("Save email");
    expect(html).toContain("keeps the same person");
    expect(html).not.toContain("\u2014");
  });

  it("asks for a name, email, optional address, and optional note", () => {
    const html = joinRequestPage();
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="address"');
    expect(html).toContain('name="note"');
    expect(html).toContain("Send request");
  });
});

describe("news admin", () => {
  const association: Association = {
    id: "assoc_tango_mar",
    slug: "tango-mar",
    name: "Tango Mar",
    legal_name: "Tango Mar Property Owners Association",
    address_line1: "31 Tang O Mar Drive",
    city: "Miramar Beach",
    state: "FL",
    postal_code: "32550",
    county: "Walton County",
    timezone: "America/Chicago",
  };
  const announcement: AnnouncementRow = {
    id: "ann-1",
    kind: "news",
    title: "Beach cleanup",
    body: "Bring bags.",
    pinned: 1,
    published_at: "2026-10-01T15:00:00.000Z",
    expires_at: null,
  };
  const event: EventRow = {
    id: "ev-1",
    title: "Board meeting",
    description: "Agenda",
    location: "Clubhouse",
    starts_at: "2026-11-08T16:00:00.000Z",
    ends_at: null,
    kind: "meeting",
  };

  it("links each row to a prefilled edit form and confirms delete", () => {
    const html = newsAdminPage({
      association,
      announcements: [announcement],
      events: [event],
      faqs: [{ id: "faq-1", question: "Where is the gate?", answer: "On the north side.", sort_order: 1 }],
      contacts: [{ id: "c-1", name: "Ada Board", role_title: "President", email: "ada@example.com", phone: "", sort_order: 1 }],
    });
    expect(html).toContain('href="/a/tango-mar/admin/news?edit=announcement&amp;id=ann-1#edit"');
    expect(html).toContain('href="/a/tango-mar/admin/news?edit=event&amp;id=ev-1#edit"');
    expect(html).toContain('href="/a/tango-mar/admin/news?edit=faq&amp;id=faq-1#edit"');
    expect(html).toContain('href="/a/tango-mar/admin/news?edit=contact&amp;id=c-1#edit"');
    expect(html).toContain(">Edit<");
    expect(html).toContain("Delete this announcement? This cannot be undone.");
    expect(html).toContain('name="confirm" value="yes"');
    expect(html).not.toContain('type="checkbox" name="confirm"');
    expect(html).not.toContain('id="edit"');
    expect(html.indexOf(">Post<")).toBeGreaterThan(html.indexOf("Beach cleanup"));
  });

  it("opens the matching edit form at the top with the saved values", () => {
    const html = newsAdminPage({
      association,
      announcements: [announcement],
      events: [event],
      faqs: [],
      contacts: [],
      editing: { kind: "announcement", row: announcement },
    });
    expect(html.indexOf('id="edit"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="edit"')).toBeLessThan(html.indexOf("<h2>Announcements</h2>"));
    expect(html).toContain("Edit announcement");
    expect(html).toContain('value="Beach cleanup"');
    expect(html).toContain(">Bring bags.</textarea>");
    expect(html).toContain('action="/a/tango-mar/admin/announcements/ann-1"');
    expect(html).toContain("Save announcement");
    expect(html).toContain("Cancel");
    expect(html).toContain(">Post<");
  });

  it("matches the edit query to the saved row", () => {
    expect(newsEdit("announcement", "ann-1", [announcement], [], [], [], association.timezone)?.kind).toBe("announcement");
    const matched = newsEdit("event", "ev-1", [], [event], [], [], association.timezone);
    expect(matched?.kind).toBe("event");
    if (matched?.kind === "event") expect(matched.startsLocal).toBe("2026-11-08T10:00");
    expect(newsEdit("faq", "missing", [], [], [], [], association.timezone)).toBeNull();
    expect(newsEdit("", "ann-1", [announcement], [], [], [], association.timezone)).toBeNull();
    expect(newsEdit("announcement", "", [announcement], [], [], [], association.timezone)).toBeNull();
  });
});

describe("resident FAQ", () => {
  it("keeps questions visible and puts answers behind a disclosure", () => {
    const html = faqPage([
      { id: "faq-1", question: "Where is the gate?", answer: "On the north side.\n\nLatch it behind you.", sort_order: 1 },
      { id: "faq-2", question: "Who <pays> dues?", answer: "Each lot.", sort_order: 2 },
    ]);
    expect(html).toContain("<h1>FAQ</h1>");
    expect(html).toContain('<details class="card faq">');
    expect(html).toContain("<summary>Where is the gate?</summary>");
    expect(html).toContain("<summary>Who &lt;pays&gt; dues?</summary>");
    expect(html).toContain('<div class="faq-answer"><p>On the north side.</p><p>Latch it behind you.</p></div>');
    expect(html.indexOf("<summary>Where is the gate?</summary>")).toBeLessThan(html.indexOf("On the north side."));
    expect(html).not.toContain("<h2>Where is the gate?</h2>");
    expect(html).not.toContain("\u2014");
    expect(faqPage([])).toContain("No questions yet.");
  });
});

describe("document viewing", () => {
  const association: Association = {
    id: "assoc_tango_mar",
    slug: "tango-mar",
    name: "Tango Mar",
    legal_name: "Tango Mar Property Owners Association",
    address_line1: "31 Tang O Mar Drive",
    city: "Miramar Beach",
    state: "FL",
    postal_code: "32550",
    county: "Walton County",
    timezone: "America/Chicago",
  };

  it("serves PDFs and images inline unless download is requested", () => {
    expect(isBrowserViewable("application/pdf")).toBe(true);
    expect(isBrowserViewable("image/jpeg")).toBe(true);
    expect(isBrowserViewable("image/png")).toBe(true);
    expect(isBrowserViewable("image/webp")).toBe(true);
    expect(isBrowserViewable("text/plain; charset=utf-8")).toBe(false);
    expect(isBrowserViewable("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
    expect(documentContentDisposition('covenants "2026".pdf', "application/pdf", false)).toBe(
      'inline; filename="covenants 2026.pdf"',
    );
    expect(documentContentDisposition("photo.png", "image/png", false)).toBe('inline; filename="photo.png"');
    expect(documentContentDisposition("photo.png", "image/png", true)).toBe('attachment; filename="photo.png"');
    expect(documentContentDisposition("notes.txt", "text/plain; charset=utf-8", false)).toBe(
      'attachment; filename="notes.txt"',
    );
  });

  it("offers View for PDFs and images and keeps Download for every file", () => {
    const documents: DocumentRow[] = [
      {
        id: "doc-pdf",
        category: "covenants",
        title: "Covenants",
        visibility: "residents",
        current_version_id: "ver-pdf",
        version_number: 2,
        filename: "covenants.pdf",
        content_type: "application/pdf",
        byte_size: 10,
        created_at: "2026-10-01T15:00:00.000Z",
      },
      {
        id: "doc-txt",
        category: "minutes",
        title: "Minutes",
        visibility: "residents",
        current_version_id: "ver-txt",
        version_number: 1,
        filename: "minutes.txt",
        content_type: "text/plain; charset=utf-8",
        byte_size: 10,
        created_at: "2026-10-01T15:00:00.000Z",
      },
    ];
    const html = documentsPage(association, documents);
    expect(html).toContain(
      '<span class="actions"><a href="/a/tango-mar/documents/doc-pdf/file" target="_blank" rel="noopener">View</a><a href="/a/tango-mar/documents/doc-pdf/file?download=1">Download</a></span>',
    );
    expect(html).toContain('<a href="/a/tango-mar/documents/doc-txt/file?download=1">Download</a>');
    expect(html).not.toContain("/documents/doc-txt/file\" target=\"_blank\"");
    expect(html).not.toContain("\u2014");
  });

  it("offers View beside Download on an admin version that can open in the browser", () => {
    const version: VersionRow = {
      id: "ver-pdf",
      document_id: "doc-pdf",
      version_number: 1,
      r2_key: "assoc/doc/v1-covenants.pdf",
      filename: "covenants.pdf",
      content_type: "application/pdf",
      byte_size: 10,
      notes: "",
      created_at: "2026-10-01T15:00:00.000Z",
    };
    const html = documentDetailPage(
      association,
      { id: "doc-pdf", title: "Covenants", category: "covenants", visibility: "residents", current_version_id: "ver-pdf" },
      [version],
    );
    expect(html).toContain(
      '<a href="/a/tango-mar/admin/documents/doc-pdf/versions/ver-pdf/file" target="_blank" rel="noopener">View</a>',
    );
    expect(html).toContain(
      '<a href="/a/tango-mar/admin/documents/doc-pdf/versions/ver-pdf/file?download=1">Download</a>',
    );
  });
});

describe("tokens", () => {
  it("hashes a magic link token with sha-256", async () => {
    const hash = await sha256Hex("abc");
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe("abc");
  });
});
