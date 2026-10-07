import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { canViewPropertyFinancials, isAdmin, keepsAnAdmin, safeNextPath, shouldRevealMagicLink } from "../src/lib/access";
import { annualDues, defaultDuesYear, lotsToInvoice } from "../src/lib/dues";
import { landingAccount, loggedOutNav, render } from "../src/views/layout";
import { documentDetailPage, documentsAdminPage, newsAdminPage, ownerDetailPage } from "../src/views/admin";
import { newsEdit } from "../src/routes/admin";
import type { AnnouncementRow, DocumentRow, EventRow, VersionRow } from "../src/db";
import { documentContentDisposition, isBrowserViewable } from "../src/lib/files";
import { documentsPage, faqPage } from "../src/views/resident";
import { checkEmailPage, homePage, invalidLinkPage, joinReceivedPage, joinRequestPage, loginPage } from "../src/views/public";
import type { OwnerListRow } from "../src/db";
import type { AppBindings, Association, Membership, User } from "../src/types";
import type { Context } from "hono";
import { parseCsv, parseOwnersCsv } from "../src/lib/csv";
import { isIsoDate, todayIso, utcToDatetimeLocal, zonedLocalToUtc } from "../src/lib/dates";
import { balanceCents, csvText, formatMoney, invoiceStatus, isDelinquent, parseMoneyToCents } from "../src/lib/money";
import { sha256Hex } from "../src/lib/tokens";
import { deliverOwnerEmails, fileToResendAttachment, loginAudienceForVisibility, ownerEmailFlash, ownerNoticeEmail, uniqueLoginEmails } from "../src/lib/email";
import { activeLoginEmails } from "../src/db";

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

describe("signed-in header", () => {
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
  const user: User = { id: "user_marc", email: "marc@example.com", name: "Marc", phone: "" };

  function membership(role: Membership["role_id"], adminFlag: number, status: Membership["status"] = "active"): Membership {
    return {
      id: "mem_marc",
      association_id: association.id,
      user_id: user.id,
      role_id: role,
      status,
      is_admin: adminFlag,
    };
  }

  function context(current: Membership | null): Context<AppBindings> {
    const vars = { user, association, membership: current, flash: null, flashTone: "ok" as const };
    return {
      get(key: keyof typeof vars) {
        return vars[key];
      },
      env: { DB: { prepare() { throw new Error("skip unread"); } } },
      req: { url: "https://mytangomar.com/a/tango-mar/dashboard" },
      res: { headers: { getSetCookie: () => [] } },
    } as unknown as Context<AppBindings>;
  }

  async function headerParts(current: Membership | null, active = "dashboard") {
    const response = await render(context(current), { title: "Dashboard", active, body: "<p>Hello</p>" });
    const html = await response.text();
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const nav = header.slice(header.indexOf("<nav>"), header.indexOf("</nav>"));
    const accountStart = header.indexOf('<div class="account">');
    const account = header.slice(accountStart, header.indexOf("</div>", accountStart));
    return { header, nav, account };
  }

  it("places Admin with the name and log out for a board admin", async () => {
    const { nav, account, header } = await headerParts(membership("board", 1));
    expect(nav).toContain("Dashboard");
    expect(nav).toContain("Documents");
    expect(nav).toContain("News");
    expect(nav).not.toContain("Admin");
    expect(account).toContain('class="account-admin" href="/a/tango-mar/admin">Admin</a>');
    expect(account).toContain("Marc");
    expect(account).toContain("Log out");
    expect(account.indexOf(">Admin<")).toBeLessThan(account.indexOf("Marc"));
    expect(account.indexOf("Marc")).toBeLessThan(account.indexOf("Log out"));
    expect(header).not.toContain("\u2014");
  });

  it("marks Admin active on admin pages and keeps it out of the resident nav", async () => {
    const { nav, account } = await headerParts(membership("board", 1), "admin");
    expect(nav).not.toContain("Admin");
    expect(account).toContain('class="account-admin active" href="/a/tango-mar/admin">Admin</a>');
    expect(account.indexOf(">Admin<")).toBeLessThan(account.indexOf("Marc"));
  });

  it("leaves Admin out for residents without admin access", async () => {
    const homeowner = await headerParts(membership("homeowner", 0));
    expect(homeowner.nav).not.toContain("Admin");
    expect(homeowner.account).not.toContain("Admin");
    expect(homeowner.account).toContain("Marc");
    expect(homeowner.account).toContain("Log out");

    const board = await headerParts(membership("board", 0));
    expect(board.nav).not.toContain("Admin");
    expect(board.account).not.toContain("Admin");

    const inactive = await headerParts(membership("board", 1, "inactive"));
    expect(inactive.nav).not.toContain("Admin");
    expect(inactive.account).not.toContain("Admin");
    expect(inactive.nav).toContain("Resident login");
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
    expect(html).toContain("<h1>News, calendar, FAQ, Board Contact</h1>");
    expect(html).toContain("<h2>Board Contact</h2>");
    expect(html).toContain("<h2>Add Board Contact</h2>");
    expect(html).toContain(">Add Board Contact<");
    expect(html).not.toContain("<h2>Contacts</h2>");
    expect(html).not.toContain("<h2>Add contact</h2>");
    expect(html).not.toContain(">Add contact<");
    expect(html).toContain(">Edit<");
    expect(html).toContain("Delete this announcement? This cannot be undone.");
    expect(html).toContain('name="confirm" value="yes"');
    expect(html).not.toContain('type="checkbox" name="confirm"');
    expect(html).not.toContain('id="edit"');
    expect(html.indexOf(">Post<")).toBeGreaterThan(html.indexOf("Beach cleanup"));
    expect(formByAction(html, "/a/tango-mar/admin/announcements")).toContain(
      '<label>Description<textarea name="body" required></textarea></label>',
    );
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
    expect(formByAction(html, "/a/tango-mar/admin/announcements/ann-1")).toContain(
      '<label>Description<textarea name="body" required>Bring bags.</textarea></label>',
    );
    expect(html).toContain('action="/a/tango-mar/admin/announcements/ann-1"');
    expect(html).toContain("Save announcement");
    expect(html).toContain("Cancel");
    expect(html).toContain(">Post<");
    expect(formByAction(html, "/a/tango-mar/admin/announcements/ann-1")).toContain(
      '<input type="checkbox" name="email_owners" value="1"> Email owners',
    );
    expect(formByAction(html, "/a/tango-mar/admin/announcements/ann-1")).not.toMatch(/name="email_owners"[^>]*checked/);
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
    expect(html).toContain("Covenants and restrictions");
    expect(html).toContain("Covenants");
    expect(html).toContain("Meeting Minutes / Agendas");
    expect(html).toContain("Minutes");
    expect(html).not.toContain("covenants.pdf");
    expect(html).not.toContain("minutes.txt");
    expect(html).not.toContain("<th>File</th>");
    expect(html).toContain(
      '<span class="actions"><a href="/a/tango-mar/documents/doc-pdf/file" target="_blank" rel="noopener">View</a><a href="/a/tango-mar/documents/doc-pdf/file?download=1">Download</a></span>',
    );
    expect(html).toContain('<a href="/a/tango-mar/documents/doc-txt/file?download=1">Download</a>');
    expect(html).not.toContain("/documents/doc-txt/file\" target=\"_blank\"");
    expect(html).not.toContain("\u2014");
  });

  it("labels the insurance category as Other for residents and admins", () => {
    const document: DocumentRow = {
      id: "doc-other",
      category: "insurance",
      title: "Community policy",
      visibility: "residents",
      current_version_id: "ver-other",
      version_number: 1,
      filename: "policy.pdf",
      content_type: "application/pdf",
      byte_size: 10,
      created_at: "2026-10-01T15:00:00.000Z",
    };
    const resident = documentsPage(association, [document]);
    expect(resident).toContain("<td>Other</td>");
    expect(resident).not.toContain("Insurance and other community documents");

    const adminList = documentsAdminPage(association, [document]);
    expect(adminList).toContain("<td>Other</td>");
    expect(adminList).toContain('<option value="insurance" >Other</option>');
    expect(adminList).not.toContain("Insurance and other community documents");

    const detail = documentDetailPage(
      association,
      { id: "doc-other", title: "Community policy", category: "insurance", visibility: "residents", current_version_id: "ver-other" },
      [],
    );
    expect(detail).toContain("Other · Owners and residents");
    expect(detail).not.toContain("Insurance and other community documents");
  });

  it("labels the minutes category as Meeting Minutes / Agendas for residents and admins", () => {
    const document: DocumentRow = {
      id: "doc-minutes",
      category: "minutes",
      title: "October agenda",
      visibility: "residents",
      current_version_id: "ver-minutes",
      version_number: 1,
      filename: "agenda.pdf",
      content_type: "application/pdf",
      byte_size: 10,
      created_at: "2026-10-01T15:00:00.000Z",
    };
    const resident = documentsPage(association, [document]);
    expect(resident).toContain("<td>Meeting Minutes / Agendas</td>");
    expect(resident).not.toContain(">Meeting minutes<");

    const adminList = documentsAdminPage(association, [document]);
    expect(adminList).toContain("<td>Meeting Minutes / Agendas</td>");
    expect(adminList).toContain('<option value="minutes" >Meeting Minutes / Agendas</option>');
    expect(adminList).not.toContain(">Meeting minutes<");

    const detail = documentDetailPage(
      association,
      { id: "doc-minutes", title: "October agenda", category: "minutes", visibility: "residents", current_version_id: "ver-minutes" },
      [],
    );
    expect(detail).toContain("Meeting Minutes / Agendas · Owners and residents");
    expect(detail).not.toContain(">Meeting minutes<");
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
    expect(html).toContain("covenants.pdf");
  });
});

describe("email owners", () => {
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

  it("starts Email owner unchecked on a portal notice and leaves the balance reminder alone", () => {
    const html = ownerDetailPage({ association, owner, balance: 0, lots: [], properties: [] });
    const form = formByAction(html, "/a/tango-mar/admin/owners/user_sam/notice");
    expect(form).toContain('<input type="checkbox" name="email_owner" value="1"> Email owner');
    expect(form).not.toMatch(/name="email_owner"[^>]*checked/);
    expect(form).toContain('enctype="multipart/form-data"');
    expect(formByAction(html, "/a/tango-mar/admin/owners/user_sam/remind")).not.toContain("email_owner");
    expect(html).not.toContain("\u2014");
  });

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

  it("leaves Email owners unchecked on announcement and event forms, and off FAQ and contacts", () => {
    const html = newsAdminPage({
      association,
      announcements: [],
      events: [],
      faqs: [{ id: "faq-1", question: "Where is the gate?", answer: "North side.", sort_order: 1 }],
      contacts: [{ id: "c-1", name: "Ada Board", role_title: "President", email: "ada@example.com", phone: "", sort_order: 1 }],
      editing: { kind: "faq", row: { id: "faq-1", question: "Where is the gate?", answer: "North side.", sort_order: 1 } },
    });
    for (const action of ["/a/tango-mar/admin/announcements", "/a/tango-mar/admin/events"]) {
      const form = formByAction(html, action);
      expect(form).toContain('<input type="checkbox" name="email_owners" value="1"> Email owners');
      expect(form).not.toMatch(/name="email_owners"[^>]*checked/);
    }
    expect(formByAction(html, "/a/tango-mar/admin/faqs/faq-1")).not.toContain("email_owners");
    expect(formByAction(html, "/a/tango-mar/admin/faqs")).not.toContain("email_owners");
    expect(formByAction(html, "/a/tango-mar/admin/contacts")).not.toContain("email_owners");
    const eventEdit = newsAdminPage({
      association,
      announcements: [],
      events: [
        {
          id: "ev-1",
          title: "Board meeting",
          description: "Agenda",
          location: "Clubhouse",
          starts_at: "2026-11-08T16:00:00.000Z",
          ends_at: null,
          kind: "meeting",
        },
      ],
      faqs: [],
      contacts: [],
      editing: {
        kind: "event",
        row: {
          id: "ev-1",
          title: "Board meeting",
          description: "Agenda",
          location: "Clubhouse",
          starts_at: "2026-11-08T16:00:00.000Z",
          ends_at: null,
          kind: "meeting",
        },
        startsLocal: "2026-11-08T10:00",
        endsLocal: "",
      },
    });
    const eventForm = formByAction(eventEdit, "/a/tango-mar/admin/events/ev-1");
    expect(eventForm).toContain('<input type="checkbox" name="email_owners" value="1"> Email owners');
    expect(eventForm).not.toMatch(/name="email_owners"[^>]*checked/);
  });

  it("puts an unchecked Email owners box on document publish and version upload", () => {
    const list = documentsAdminPage(association, []);
    const publish = formByAction(list, "/a/tango-mar/admin/documents");
    expect(publish).toContain('<input type="checkbox" name="email_owners" value="1"> Email owners');
    expect(publish).not.toMatch(/name="email_owners"[^>]*checked/);

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
    for (const visibility of ["residents", "board"] as const) {
      const html = documentDetailPage(
        association,
        { id: "doc-pdf", title: "Covenants", category: "covenants", visibility, current_version_id: "ver-pdf" },
        [version],
      );
      const form = formByAction(html, "/a/tango-mar/admin/documents/doc-pdf/versions");
      expect(form).toContain('<input type="checkbox" name="email_owners" value="1"> Email owners');
      expect(form).not.toMatch(/name="email_owners"[^>]*checked/);
      expect(formByAction(html, "/a/tango-mar/admin/documents/doc-pdf/visibility")).not.toContain("email_owners");
      expect(formByAction(html, "/a/tango-mar/admin/documents/doc-pdf/delete")).not.toContain("email_owners");
    }
  });

  it("writes a short portal link and does not attach a file", () => {
    const letter = ownerNoticeEmail({
      associationName: "Tango Mar",
      slug: "tango-mar",
      kind: "announcement",
      title: "Beach\ncleanup",
      summary: "Bring bags.",
      itemId: "ann-1",
    });
    expect(letter.subject).toBe("Tango Mar: Beach cleanup");
    expect(letter.subject).not.toContain("\n");
    expect(letter.text).toContain("Bring bags.");
    expect(letter.href).toBe("https://mytangomar.com/a/tango-mar/news/ann-1");
    expect(letter.text).toContain(letter.href);
    expect(letter.text).not.toContain("\u2014");

    expect(
      ownerNoticeEmail({
        associationName: "Tango Mar",
        slug: "tango-mar",
        kind: "event",
        title: "Board meeting",
        summary: "November 8 at the clubhouse",
      }).href,
    ).toBe("https://mytangomar.com/a/tango-mar/calendar");

    const doc = ownerNoticeEmail({
      associationName: "Tango Mar",
      slug: "tango-mar",
      kind: "document",
      title: "Covenants",
      summary: "Updated rules.",
    });
    expect(doc.href).toBe("https://mytangomar.com/a/tango-mar/documents");
    expect(doc.text).not.toMatch(/attachment|r2_key/i);
    expect(doc.text).not.toContain("\u2014");

    const notice = ownerNoticeEmail({
      associationName: "Tango Mar",
      slug: "tango-mar",
      kind: "account",
      title: "Gate\ncode",
      summary: "The new code is 1234.",
      attachmentName: "rules.pdf",
    });
    expect(notice.subject).toBe("Tango Mar: Gate code");
    expect(notice.href).toBe("https://mytangomar.com/a/tango-mar/notices");
    expect(notice.text).toContain("Tango Mar posted a notice.");
    expect(notice.text).toContain("The new code is 1234.");
    expect(notice.text).toContain("Attached file: rules.pdf");
    expect(notice.text).toContain(notice.href);
    expect(notice.text).not.toContain("\u2014");
    expect(
      ownerNoticeEmail({
        associationName: "Tango Mar",
        slug: "tango-mar",
        kind: "account",
        title: "Gate code",
        summary: "The new code is 1234.",
      }).text,
    ).not.toContain("Attached file");
  });

  it("attaches a notice file through Resend and skips mail when Resend is missing", async () => {
    const file = new File([Uint8Array.from([1, 2, 3, 4])], "rules.pdf", { type: "application/pdf" });
    const attachment = await fileToResendAttachment(file);
    expect(attachment).toEqual({
      filename: "rules.pdf",
      content: btoa(String.fromCharCode(1, 2, 3, 4)),
      contentType: "application/pdf",
    });
    expect(await fileToResendAttachment(new File([], "empty.pdf", { type: "application/pdf" }))).toBeNull();
    expect(await fileToResendAttachment(new File(["hi"], "notes.exe", { type: "application/octet-stream" }))).toBeNull();

    const bodies: { to: string[]; attachments?: { filename: string; content: string; content_type: string }[]; html?: unknown; text: string }[] = [];
    const delivery = await deliverOwnerEmails({
      apiKey: "test-key",
      from: "Tango Mar <donotreply@mytangomar.com>",
      recipients: [{ email: "sam.rivera@example.com" }],
      subject: "Tango Mar: Gate code",
      text: "Open notices\nhttps://mytangomar.com/a/tango-mar/notices",
      attachments: attachment ? [attachment] : undefined,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
        return new Response("ok", { status: 200 });
      },
    });
    expect(delivery).toEqual({ sent: 1, failed: 0, skipped: false });
    expect(bodies[0]?.to).toEqual(["sam.rivera@example.com"]);
    expect(bodies[0]?.attachments).toEqual([
      { filename: "rules.pdf", content: attachment?.content, content_type: "application/pdf" },
    ]);
    expect(bodies[0]?.html).toBeUndefined();
    expect(
      ownerEmailFlash({
        saved: "Notice posted to their portal.",
        audience: "owners",
        recipients: 1,
        delivery: { sent: 0, failed: 0, skipped: true },
      }),
    ).toMatchObject({ message: "Notice posted to their portal. Email was not sent.", tone: "warn" });
    expect(
      ownerEmailFlash({
        saved: "Notice posted to their portal.",
        audience: "owners",
        recipients: 1,
        delivery,
      }).message,
    ).toBe("Notice posted to their portal. Emailed 1 owner.");
  });

  it("keeps one email per person and sends board-only files only to the board", () => {
    expect(loginAudienceForVisibility("board")).toBe("board");
    expect(loginAudienceForVisibility("residents")).toBe("owners");
    expect(
      uniqueLoginEmails([
        { id: "1", email: "Sam@example.com" },
        { id: "2", email: "sam@example.com" },
        { id: "3", email: "  " },
        { id: "4", email: "ada@example.com" },
      ]).map((row) => row.email),
    ).toEqual(["Sam@example.com", "ada@example.com"]);
  });

  it("still saves when email is not configured, and reports a partial send", async () => {
    expect(
      ownerEmailFlash({
        saved: "Announcement posted.",
        audience: "owners",
        recipients: 2,
        delivery: { sent: 2, failed: 0, skipped: false },
      }),
    ).toMatchObject({ message: "Announcement posted. Emailed 2 owners.", tone: "ok", note: "Emailed 2 owners." });
    expect(
      ownerEmailFlash({
        saved: "Document published.",
        audience: "board",
        recipients: 1,
        delivery: { sent: 1, failed: 0, skipped: false },
      }).message,
    ).toBe("Document published. Emailed 1 board member.");
    expect(
      ownerEmailFlash({
        saved: "Event added.",
        audience: "owners",
        recipients: 3,
        delivery: { sent: 0, failed: 0, skipped: true },
      }),
    ).toMatchObject({ message: "Event added. Email was not sent.", tone: "warn" });
    expect(
      ownerEmailFlash({
        saved: "Announcement saved.",
        audience: "owners",
        recipients: 0,
        delivery: { sent: 0, failed: 0, skipped: false },
      }).message,
    ).toBe("Announcement saved. No active logins to email.");

    const bodies: { to: string[]; attachments?: unknown; html?: unknown; text: string }[] = [];
    const delivery = await deliverOwnerEmails({
      apiKey: "test-key",
      from: "Tango Mar <donotreply@mytangomar.com>",
      recipients: [{ email: "a@example.com" }, { email: "b@example.com" }],
      subject: "Tango Mar: Covenants",
      text: "Open documents\nhttps://mytangomar.com/a/tango-mar/documents",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { to: string[]; attachments?: unknown; html?: unknown; text: string };
        bodies.push(body);
        expect(body.attachments).toBeUndefined();
        expect(body.html).toBeUndefined();
        return new Response("no", { status: body.to[0] === "a@example.com" ? 200 : 500 });
      },
    });
    expect(delivery).toEqual({ sent: 1, failed: 1, skipped: false });
    expect(bodies.map((body) => body.to[0])).toEqual(["a@example.com", "b@example.com"]);
    expect(
      ownerEmailFlash({ saved: "Document published.", audience: "owners", recipients: 2, delivery }).message,
    ).toBe("Document published. Emailed 1 of 2 owners.");

    const skipped = await deliverOwnerEmails({
      from: "Tango Mar <donotreply@mytangomar.com>",
      recipients: [{ email: "a@example.com" }],
      subject: "Hi",
      text: "Hi",
      fetchImpl: async () => {
        throw new Error("should not send");
      },
    });
    expect(skipped).toEqual({ sent: 0, failed: 0, skipped: true });
  });

  it("emails each active login once, and board-only files skip homeowners", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(readFileSync("migrations/0001_schema.sql", "utf8"));
    sqlite.exec(readFileSync("migrations/0002_seed_tango_mar.sql", "utf8"));
    sqlite.exec(`
      INSERT INTO properties (id, association_id, lot_number, street_address, status, created_at)
      VALUES ('prop_sam_2', 'assoc_tango_mar', '15', 'Lot 15', 'active', '2026-10-02T00:00:00Z');
      INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
      VALUES ('own_sam_2', 'assoc_tango_mar', 'prop_sam_2', 'user_sam', 0, '2026-10-02T00:00:00Z');
      INSERT INTO users (id, email, name, created_at) VALUES
        ('user_board', 'ada.board@example.com', 'Ada Board', '2026-10-02T00:00:00Z'),
        ('user_inactive', 'old.owner@example.com', 'Old Owner', '2026-10-02T00:00:00Z'),
        ('user_invited', 'new.owner@example.com', 'New Owner', '2026-10-02T00:00:00Z'),
        ('user_blank', '', 'No Email', '2026-10-02T00:00:00Z');
      INSERT INTO memberships (id, association_id, user_id, role_id, status, created_at) VALUES
        ('mem_board', 'assoc_tango_mar', 'user_board', 'board', 'active', '2026-10-02T00:00:00Z'),
        ('mem_inactive', 'assoc_tango_mar', 'user_inactive', 'homeowner', 'inactive', '2026-10-02T00:00:00Z'),
        ('mem_invited', 'assoc_tango_mar', 'user_invited', 'homeowner', 'invited', '2026-10-02T00:00:00Z'),
        ('mem_blank', 'assoc_tango_mar', 'user_blank', 'homeowner', 'active', '2026-10-02T00:00:00Z');
    `);
    const db = new SqliteD1(sqlite);
    const owners = uniqueLoginEmails(await activeLoginEmails(db as unknown as D1Database, "assoc_tango_mar", "owners"));
    expect(owners.map((row) => row.email)).toEqual([
      "ada.board@example.com",
      "casey.nguyen@example.com",
      "jordan.lee@example.com",
      "sam.rivera@example.com",
    ]);
    const board = uniqueLoginEmails(await activeLoginEmails(db as unknown as D1Database, "assoc_tango_mar", "board"));
    expect(board.map((row) => row.email)).toEqual(["ada.board@example.com", "jordan.lee@example.com"]);
    sqlite.close();
  });
});

class SqliteStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.sqlite, this.sql, values);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.sqlite.prepare(this.sql).all(...(this.params as (string | number | null | bigint)[]));
    return { results: rows as T[] };
  }
}

class SqliteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.sqlite, query);
  }
}

function formByAction(html: string, action: string): string {
  const marker = `action="${action}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</form>", start);
  return html.slice(start, end);
}

describe("tokens", () => {
  it("hashes a magic link token with sha-256", async () => {
    const hash = await sha256Hex("abc");
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe("abc");
  });
});
