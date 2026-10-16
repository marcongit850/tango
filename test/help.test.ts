import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bankTransferFeeHelp } from "../src/lib/bank-fee";
import { paymentSettingsPage, usersPage } from "../src/views/admin";
import {
  BOARD_ONLY_HELP,
  CLEAR_STUCK_HELP,
  ELECTRONIC_NOTICE_HELP,
  INVOICE_EMAIL_HELP,
  LATE_FEE_HELP,
  PROCESSING_HELP,
  ROLE_HELP,
  STRIPE_KEY_HELP,
  WEBHOOK_HELP,
  helpTip,
} from "../src/views/help";
import { render } from "../src/views/layout";
import {
  dashboardPage,
  documentsPage,
  paySelectPage,
  paySuccessPage,
  paymentListPage,
  profilePage,
  sampleCheckoutPage,
} from "../src/views/resident";
import type { DocumentRow, OwnerListRow } from "../src/db";
import type { AppBindings, Association, Membership, User } from "../src/types";
import type { Context } from "hono";

const association: Association = {
  id: "assoc_tango_mar",
  slug: "tango-mar",
  name: "Tang-O-Mar",
  legal_name: "Tang-O-Mar Property Owners Association",
  address_line1: "31 Tang O Mar Drive",
  city: "Miramar Beach",
  state: "FL",
  postal_code: "32550",
  county: "Walton County",
  timezone: "America/Chicago",
};

const FEE_HELP =
  "This small fee covers the cost of the bank transfer. It's about 0.8%, never more than $5.00, and it doesn't count toward your dues. To avoid it, mail a check to the association.";

const COPY = [FEE_HELP, PROCESSING_HELP, ELECTRONIC_NOTICE_HELP, STRIPE_KEY_HELP, WEBHOOK_HELP, ROLE_HELP, BOARD_ONLY_HELP, CLEAR_STUCK_HELP, INVOICE_EMAIL_HELP, LATE_FEE_HELP];

function shown(text: string): string {
  return text.replaceAll("'", "&#39;");
}

describe("help copy", () => {
  it("uses the approved Users role sentence", () => {
    expect(ROLE_HELP).toBe(
      "Owners see their own account, invoices, and documents. Board members also see board-only documents. Anyone with edit access, including admins, can edit owners, lots, invoices, and settings and gets staff notices.",
    );
  });

  it("uses the saved fee percent and cap in the same format as the owner note", () => {
    expect(bankTransferFeeHelp({ enabled: true, percentBps: 80, capCents: 500 })).toBe(FEE_HELP);
    expect(bankTransferFeeHelp({ enabled: true, percentBps: 125, capCents: 1000 })).toBe(
      "This small fee covers the cost of the bank transfer. It's about 1.25%, never more than $10.00, and it doesn't count toward your dues. To avoid it, mail a check to the association.",
    );
  });

  it("keeps the approved sentences free of em and en dashes", () => {
    for (const text of COPY) {
      expect(text).not.toContain("\u2014");
      expect(text).not.toContain("\u2013");
    }
  });
});

describe("help control", () => {
  it("renders one button and a dialog from the shared helper", () => {
    const html = helpTip("Processing fee", "It's about 0.8%.");
    const again = helpTip("Processing fee", "It's about 0.8%.");
    expect(html).toContain('type="button"');
    expect(html).toContain('class="help-btn"');
    expect(html).toContain('aria-label="Help: Processing fee"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("hidden");
    expect(html).toContain("It&#39;s about 0.8%.");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
    const id = html.match(/aria-controls="(help-[^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(again).not.toContain(`id="${id}"`);
  });
});

describe("help placements", () => {
  const boardDoc: DocumentRow = {
    id: "doc-budget",
    category: "budgets",
    title: "2026 budget",
    visibility: "board",
    current_version_id: null,
    version_number: null,
    filename: null,
    content_type: null,
    byte_size: null,
    created_at: null,
  };

  it("places the fee help on Pay now and the sample checkout", () => {
    const custom = { enabled: true, percentBps: 125, capCents: 1000 };
    const pay = paySelectPage({
      association,
      invoices: [{ invoiceId: "inv", lotNumber: "14", invoiceNumber: "2026-14", amountCents: 10_000 }],
      offer: { kind: "demo" },
      message: "",
      fee: custom,
    });
    expect(pay).toContain('aria-label="Help: Processing fee"');
    expect(pay).toContain(shown(bankTransferFeeHelp(custom)));
    expect(pay).toContain('aria-expanded="false"');
    const off = paySelectPage({
      association,
      invoices: [{ invoiceId: "inv", lotNumber: "14", invoiceNumber: "2026-14", amountCents: 10_000 }],
      offer: { kind: "stripe", mode: "live" },
      message: "",
      fee: { enabled: false, percentBps: 80, capCents: 500 },
    });
    expect(off).not.toContain("Help: Processing fee");

    const sample = sampleCheckoutPage({
      association,
      invoices: [{ invoiceId: "inv", lotNumber: "14", invoiceNumber: "2026-14", amountCents: 10_000 }],
      successHref: "/ok",
      cancelHref: "/no",
      feeCents: 81,
      fee: { enabled: true, percentBps: 80, capCents: 500 },
    });
    expect(sample).toContain(shown(FEE_HELP));
  });

  it("places the processing help wherever owners see that status", () => {
    const dash = dashboardPage({
      association,
      name: "Sam",
      ledger: [],
      upcoming: [],
      invoices: [],
      payments: [],
      notices: [],
      emergencies: [],
      bankTransferProcessing: true,
    });
    expect(dash).toContain(`Processing, usually 4 business days${helpMarkupStart()}`);
    expect(dash).toContain(shown(PROCESSING_HELP));
    const quiet = dashboardPage({
      association,
      name: "Sam",
      ledger: [],
      upcoming: [],
      invoices: [],
      payments: [],
      notices: [],
      emergencies: [],
    });
    expect(quiet).not.toContain("Help: Processing");

    const history = paymentListPage(association, [], [
      { id: "intent", amountCents: 1000, feeCents: 8, lotNumbers: "14", createdAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(history.match(/class="help-btn" aria-label="Help: Processing"/g)?.length).toBe(2);

    const submitted = paySuccessPage({ association, sample: null, state: "processing" });
    expect(submitted).toContain(shown(PROCESSING_HELP));
    const paid = paySuccessPage({ association, sample: null, state: "succeeded" });
    expect(paid).not.toContain("Help: Processing");
  });

  it("places consent, board-only, payment settings, and role help", () => {
    const profile = profilePage({ association, name: "Sam", email: "sam@example.com", phone: "", lots: [] });
    expect(profile).toContain(`<h2>Electronic Notice Consent${helpMarkupStart()}`);
    expect(profile).toContain(shown(ELECTRONIC_NOTICE_HELP));

    const docs = documentsPage(association, [boardDoc]);
    expect(docs).toContain(`<h2>Board only${helpMarkupStart()}`);
    expect(docs).toContain(shown(BOARD_ONLY_HELP));
    expect(documentsPage(association, [{ ...boardDoc, visibility: "residents", title: "Covenants" }])).not.toContain("Board only");

    const settings = paymentSettingsPage({
      association,
      ready: true,
      encryptionReady: true,
      status: "test mode",
      secretLast4: "1234",
      secretMode: "test",
      webhookLast4: "",
      webhookUrl: "https://myhoadashboard.com/tangomar/webhooks/stripe",
      demo: false,
      feeReady: true,
      feeEnabled: true,
      feePercent: "0.8",
      feeCap: "5.00",
      invoiceEmailsReady: true,
      invoiceEmailsEnabled: false,
      processing: [{ id: "intent_stuck", amountCents: 40050, feeCents: 323, lotNumbers: "27", createdAt: "2026-10-01T00:00:00.000Z" }],
    });
    const stripeAt = settings.indexOf("<h2>Stripe secret key");
    const webhookAt = settings.indexOf("<h2>Webhook");
    expect(stripeAt).toBeGreaterThan(-1);
    expect(webhookAt).toBeGreaterThan(-1);
    expect(settings.slice(stripeAt, stripeAt + 900)).toContain(shown(STRIPE_KEY_HELP));
    expect(settings.slice(webhookAt, webhookAt + 700)).toContain(shown(WEBHOOK_HELP));
    expect(settings).toContain("Clear stuck transfer");
    expect(settings).toContain(shown(CLEAR_STUCK_HELP));
    expect(settings).toContain('aria-label="Help: Invoice emails"');
    expect(settings).toContain(INVOICE_EMAIL_HELP);
    expect(settings).toContain("Save invoice emails");
    expect(settings).not.toContain('name="invoice_emails" value="yes" checked');
    expect(settings).toContain('aria-label="Help: Late fees"');
    expect(settings).toContain(LATE_FEE_HELP);
    expect(settings).toContain('id="late-fees"');
    expect(settings.slice(settings.indexOf("<h2>Webhook signing secret"), settings.indexOf("<h2>Webhook signing secret") + 80)).not.toContain("help-btn");

    const owner: OwnerListRow = {
      user_id: "user_ada",
      email: "ada@example.com",
      name: "Ada",
      phone: "",
      role_id: "homeowner",
      is_admin: 0,
      is_master: 0,
      status: "active",
      property_id: null,
      lot_number: null,
      street_address: null,
    };
    const users = usersPage(association, [{ owner, lots: [] }], 1, "all", true);
    expect(users.match(/class="help-btn" aria-label="Help: Role"/g)?.length).toBe(4);
    expect(users).toContain('class="help help-desktop"');
    expect(users).toContain('class="help help-mobile"');
    expect(users).toContain(shown(ROLE_HELP));
    const readOnly = usersPage(association, [{ owner, lots: [] }], 1, "all", false);
    expect(readOnly.match(/class="help-btn" aria-label="Help: Role"/g)?.length).toBe(2);
  });
});

function helpMarkupStart(): string {
  return '<span class="help">';
}

describe("help script", () => {
  it("is a static file the portal shell loads under the existing CSP", async () => {
    const source = readFileSync("public/help.js", "utf8");
    expect(source).toContain("Escape");
    expect(source).toContain("aria-expanded");
    expect(source).not.toContain("eval(");
    const user: User = { id: "user_sam", email: "sam@example.com", name: "Sam", phone: "" };
    const membership: Membership = {
      id: "mem",
      association_id: association.id,
      user_id: user.id,
      role_id: "homeowner",
      status: "active",
      is_admin: 0,
    };
    const vars = { user, association, membership, flash: null, flashTone: "ok" as const, demoRole: null };
    const context = {
      get(key: keyof typeof vars) {
        return vars[key];
      },
      env: { DB: { prepare() { throw new Error("skip unread"); } } },
      req: { url: "https://myhoadashboard.com/a/tango-mar/dashboard" },
      res: { headers: { getSetCookie: () => [] } },
    } as unknown as Context<AppBindings>;
    const response = await render(context, { title: "Dashboard", active: "dashboard", body: "<p>Hello</p>" });
    const html = await response.text();
    expect(html).toContain('<script src="/help.js" defer></script>');
    expect(html).toContain(".help-btn");
    expect(html).toContain(".help-pop");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("script-src 'unsafe-inline'");
  });

  it("opens, closes, and stays inside the viewport", () => {
    const source = readFileSync("public/help.js", "utf8");
    new Function(source)();
    const install = (globalThis as { installHelpTips?: (doc: MiniDoc, win: MiniWin) => void }).installHelpTips;
    expect(install).toBeTypeOf("function");

    const doc = new MiniDoc();
    const win = new MiniWin();
    const home = new MiniNode("", "help");
    const button = new MiniNode("", "help-btn");
    button.setAttribute("aria-controls", "help-1");
    button.setAttribute("aria-expanded", "false");
    const mark = new MiniNode("", "help-mark");
    const pop = doc.register(new MiniNode("help-1", "help-pop"));
    pop.hidden = true;
    button.appendChild(mark);
    home.appendChild(button);
    home.appendChild(pop);
    doc.body.appendChild(home);

    const otherHome = new MiniNode("", "help");
    const otherButton = new MiniNode("", "help-btn");
    otherButton.setAttribute("aria-controls", "help-2");
    otherButton.setAttribute("aria-expanded", "false");
    const otherPop = doc.register(new MiniNode("help-2", "help-pop"));
    otherPop.hidden = true;
    otherHome.appendChild(otherButton);
    otherHome.appendChild(otherPop);
    doc.body.appendChild(otherHome);

    install!(doc, win);

    const opened = doc.dispatchClick(mark);
    expect(opened.defaultPrevented).toBe(true);
    expect(opened.stopped).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(pop.hidden).toBe(false);
    expect(pop.focused).toBe(true);
    expect(pop.parentNode).toBe(doc.body);

    doc.dispatchClick(pop);
    expect(pop.hidden).toBe(false);

    doc.dispatchClick(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(pop.hidden).toBe(true);
    expect(pop.parentNode).toBe(home);

    doc.dispatchClick(button);
    doc.dispatchKey("Escape", pop);
    expect(pop.hidden).toBe(true);
    expect(button.focused).toBe(true);

    button.focused = false;
    doc.dispatchClick(button);
    const outside = new MiniNode();
    doc.body.appendChild(outside);
    doc.dispatchClick(outside);
    expect(pop.hidden).toBe(true);
    expect(button.focused).toBe(false);

    button.rect = { left: 960, top: 100, right: 980, bottom: 120, width: 20, height: 20 };
    doc.dispatchClick(button);
    expect(Number.parseFloat(pop.style.left)).toBe(1000 - 8 - 288);
    expect(Number.parseFloat(pop.style.top)).toBe(126);

    button.rect = { left: 20, top: 740, right: 40, bottom: 760, width: 20, height: 20 };
    win.fire("resize");
    expect(Number.parseFloat(pop.style.left)).toBe(20);
    expect(Number.parseFloat(pop.style.top)).toBe(740 - 96 - 6);

    doc.dispatchClick(otherButton);
    expect(pop.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(otherPop.hidden).toBe(false);
    expect(otherButton.getAttribute("aria-expanded")).toBe("true");
  });
});

type Handler = (event: MiniEvent) => void;

class MiniEvent {
  defaultPrevented = false;
  stopped = false;
  constructor(
    public target: MiniNode,
    public key = "",
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.stopped = true;
  }
}

class MiniNode {
  parentNode: MiniNode | null = null;
  children: MiniNode[] = [];
  hidden = false;
  style: Record<string, string> = {};
  focused = false;
  offsetWidth = 288;
  offsetHeight = 96;
  rect = { left: 20, top: 20, right: 40, bottom: 40, width: 20, height: 20 };
  private attributes: Record<string, string> = {};
  private classNames: string[];

  constructor(
    public id = "",
    className = "",
  ) {
    this.classNames = className.split(/\s+/).filter(Boolean);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  matches(selector: string): boolean {
    return selector.startsWith(".") && this.classNames.includes(selector.slice(1));
  }

  closest(selector: string): MiniNode | null {
    let node: MiniNode | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  contains(node: MiniNode | null): boolean {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  appendChild(child: MiniNode): MiniNode {
    if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  getBoundingClientRect(): MiniNode["rect"] {
    return this.rect;
  }

  focus(): void {
    this.focused = true;
  }
}

class MiniDoc {
  body = new MiniNode("body");
  private clicks: Handler[] = [];
  private keys: Handler[] = [];
  private nodes = new Map<string, MiniNode>();

  addEventListener(type: string, handler: Handler, capture?: boolean): void {
    if (type === "click" && capture) this.clicks.push(handler);
    if (type === "keydown") this.keys.push(handler);
  }

  getElementById(id: string): MiniNode | null {
    return this.nodes.get(id) ?? null;
  }

  register(node: MiniNode): MiniNode {
    if (node.id) this.nodes.set(node.id, node);
    return node;
  }

  dispatchClick(target: MiniNode): MiniEvent {
    const event = new MiniEvent(target);
    for (const handler of this.clicks) handler(event);
    return event;
  }

  dispatchKey(key: string, target: MiniNode): MiniEvent {
    const event = new MiniEvent(target, key);
    for (const handler of this.keys) handler(event);
    return event;
  }
}

class MiniWin {
  innerWidth = 1000;
  innerHeight = 800;
  private handlers: Record<string, Handler[]> = {};

  addEventListener(type: string, handler: Handler): void {
    this.handlers[type] = this.handlers[type] ?? [];
    this.handlers[type].push(handler);
  }

  fire(type: string): void {
    for (const handler of this.handlers[type] ?? []) handler(new MiniEvent(new MiniNode()));
  }
}
