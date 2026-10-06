import { describe, expect, it } from "vitest";
import { canViewPropertyFinancials, isStaff, safeNextPath, shouldRevealMagicLink } from "../src/lib/access";
import { checkEmailPage, homePage, joinReceivedPage, joinRequestPage, loginPage } from "../src/views/public";
import type { Association } from "../src/types";
import { parseCsv, parseOwnersCsv } from "../src/lib/csv";
import { isIsoDate, todayIso, zonedLocalToUtc } from "../src/lib/dates";
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
    expect(parsed.rows[1]).toMatchObject({ role: "homeowner", startingBalanceCents: 0, balanceAsOf: "2026-10-06" });
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
  it("hides another resident's ledger and shows it to the board", () => {
    expect(canViewPropertyFinancials("homeowner", "user_sam", ["user_casey"])).toBe(false);
    expect(canViewPropertyFinancials("homeowner", "user_sam", ["user_sam"])).toBe(true);
    expect(canViewPropertyFinancials("board", "user_quinn", ["user_sam"])).toBe(true);
    expect(canViewPropertyFinancials("officer", "user_jordan", [])).toBe(true);
    expect(canViewPropertyFinancials("public", "visitor", ["user_sam"])).toBe(false);
    expect(isStaff("homeowner")).toBe(false);
    expect(isStaff("officer")).toBe(true);
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
  });
});

describe("public home", () => {
  it("offers resident login and request to join", () => {
    const html = homePage(false);
    expect(html).toContain("Resident login");
    expect(html).toContain('href="/a/tango-mar/login"');
    expect(html).toContain("Request to join");
    expect(html).toContain('href="/join"');
    expect(html).toContain(
      "Welcome to your neighborhood dashboard. Here you can access association information, community documents, announcements, account details, and other resources for homeowners of the Tango Mar Property Owners Association.",
    );
    expect(html).not.toContain("A beach neighborhood in Miramar Beach");
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
    const check = checkEmailPage(association.name, null);
    expect(check).toContain(
      "If your email is on the Tango Mar roster, your secure sign-in link is on the way. The link expires in 20 minutes and can only be used once. After you sign in, you’ll stay logged in on this device for up to 30 days.",
    );
    expect(check).not.toContain("a sign-in link is on its way");
  });

  it("shows the fictional roster only for the local demo", () => {
    expect(homePage(true)).toContain("jordan.lee@example.com");
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

describe("tokens", () => {
  it("hashes a magic link token with sha-256", async () => {
    const hash = await sha256Hex("abc");
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe("abc");
  });
});
