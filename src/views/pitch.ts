import { esc } from "../lib/html";
import type { DemoIntent } from "../lib/demo-request";

const SHOT_DESKTOP = "/bring/dashboard-desktop.webp";
const SHOT_PHONE = "/bring/dashboard-phone.webp";
const SHOT_FULL = "/bring/dashboard-full.webp";

export type PitchPageOptions = {
  intent?: DemoIntent;
  sent?: boolean;
  error?: string;
  values?: {
    name?: string;
    email?: string;
    hoa?: string;
    phone?: string;
    homes?: string;
    message?: string;
  };
};

function requestLink(intent: DemoIntent, label: string): string {
  return `<a class="button" href="/bring-this-to-your-hoa?intent=${intent}#demo-form" data-demo-intent="${intent}">${label} <span aria-hidden="true">→</span></a>`;
}

const SVG = `viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;

function icon(paths: string): string {
  return `<svg ${SVG}>${paths}</svg>`;
}

const ICONS = {
  shield: icon(`<path d="M12 3.5 19 6.2v5.3c0 4.2-2.8 6.8-7 8.5-4.2-1.7-7-4.3-7-8.5V6.2L12 3.5z"/>`),
  document: icon(
    `<path d="M7 3.5h6.2L18 8.2V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M13 3.5V8.5h5"/><path d="M9 12.5h6M9 16h6"/>`,
  ),
  account: icon(
    `<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="11" r="2"/><path d="M6.6 16.2c.45-1.5 1.5-2.3 2.4-2.3s1.95.8 2.4 2.3"/><path d="M13.4 10.5h4M13.4 13.5h4"/>`,
  ),
  card: icon(`<rect x="3" y="6" width="18" height="12" rx="1.6"/><path d="M3 10h18M7 14.5h4"/>`),
  megaphone: icon(
    `<path d="M5 9.5v5h2.2L12 18V6L7.2 9.5H5z"/><path d="M15 9.5a3.2 3.2 0 0 1 0 5"/><path d="M17.2 7.2a6 6 0 0 1 0 9.6"/>`,
  ),
  chat: icon(
    `<path d="M5 6.2h9.2A1.8 1.8 0 0 1 16 8v4.2a1.8 1.8 0 0 1-1.8 1.8H8.2L5 16.8v-2.6A1.8 1.8 0 0 1 3.2 12.4V8A1.8 1.8 0 0 1 5 6.2z"/><path d="M8.2 9.2h8.6A1.6 1.6 0 0 1 18.4 10.8V15a1.6 1.6 0 0 1-1.6 1.6h-.4"/>`,
  ),
  people: icon(
    `<circle cx="9" cy="9" r="2.2"/><circle cx="16" cy="9.6" r="1.7"/><path d="M4.8 17.4c.6-2.2 2.2-3.3 4.2-3.3s3.6 1.1 4.2 3.3"/><path d="M14.2 16.8c.35-1.3 1.3-2 2.5-2 1 0 1.9.55 2.3 1.7"/>`,
  ),
  gear: icon(
    `<circle cx="12" cy="12" r="3"/><path d="M12 3.6v2.1M12 18.3v2.1M3.6 12h2.1M18.3 12h2.1M6.2 6.2l1.5 1.5M16.3 16.3l1.5 1.5M17.8 6.2l-1.5 1.5M7.7 16.3l-1.5 1.5"/>`,
  ),
  upload: icon(
    `<path d="M8 17.6h8.1a3.2 3.2 0 0 0 .5-6.4 4.5 4.5 0 0 0-8.6 1.3A2.7 2.7 0 0 0 8 17.6z"/><path d="M12 10.2v5.2M9.7 12.5 12 10.2l2.3 2.3"/>`,
  ),
  clipboard: icon(`<rect x="6.2" y="4.2" width="11.6" height="15.6" rx="1.4"/><path d="M9 4.2h6V6.6H9zM9 11h6M9 14.4h4"/>`),
  lock: icon(`<rect x="6" y="10.6" width="12" height="8" rx="1.4"/><path d="M8.4 10.6V8.3a3.6 3.6 0 0 1 7.2 0v2.3"/>`),
  spark: icon(`<path d="M12 3.2v3.2M12 17.6V21M3.2 12h3.2M17.6 12H21M6 6l2.2 2.2M15.8 15.8 18 18M18 6l-2.2 2.2M8.2 15.8 6 18"/><circle cx="12" cy="12" r="2.2"/>`),
  bell: icon(`<path d="M6 16.4h12l-1.2-1.9V11a4.8 4.8 0 0 0-9.6 0v3.5L6 16.4z"/><path d="M10 16.6a2 2 0 0 0 4 0"/>`),
  house: icon(`<path d="M4 11.4 12 4.8l8 6.6"/><path d="M7 10.6V19h10v-8.4"/>`),
  check: icon(`<circle cx="12" cy="12" r="8"/><path d="M8.4 12.2 10.9 14.6 15.6 9.6"/>`),
};

function featureCard(kind: string, glyph: string, title: string, text: string, soon = false): string {
  return `<article class="home-card home-card-${kind}">
      <div class="home-icon">${glyph}</div>
      <h3>${title}</h3>
      <p>${text}</p>
      ${soon ? `<span class="badge">Coming Soon</span>` : ""}
    </article>`;
}

function boardPoint(glyph: string, title: string, text: string): string {
  return `<article>
      <div class="pitch-board-icon">${glyph}</div>
      <h3>${title}</h3>
      <p>${text}</p>
    </article>`;
}

function priceCard(options: {
  title: string;
  intro: string;
  items: string[];
  intent: DemoIntent;
  label: string;
  popular?: boolean;
  price?: string;
}): string {
  const popular = options.popular ? `<p class="pitch-popular">Most popular</p>` : "";
  const price = options.price
    ? `<p class="muted">Starting at</p><p class="pitch-amount">${options.price}</p>`
    : "";
  const items = options.items.map((item) => `<li>${item}</li>`).join("");
  return `<article class="pitch-price${options.popular ? " popular" : ""}">
      ${popular}
      <h3>${options.title}</h3>
      ${price}
      <p>${options.intro}</p>
      <ul>${items}</ul>
      ${requestLink(options.intent, options.label)}
    </article>`;
}

function featureRow(name: string, status: "Included" | "Coming Soon", notes: string): string {
  const badge = status === "Included" ? `<span class="pitch-status">Included</span>` : `<span class="pitch-status soon">Coming Soon</span>`;
  return `<tr><td>${name}</td><td>${badge}</td><td>${notes}</td></tr>`;
}

function soonCard(glyph: string, title: string, text: string): string {
  return `<article>
      <div class="pitch-soon-icon">${glyph}</div>
      <h3>${title}</h3>
      <p><span class="badge">Coming Soon</span></p>
      <p>${text}</p>
    </article>`;
}

function faqItem(question: string, answer: string): string {
  return `<details class="faq panel">
      <summary>${question}</summary>
      <div class="faq-answer"><p>${answer}</p></div>
    </details>`;
}

function intentLabel(intent: DemoIntent): string {
  if (intent === "pricing") return "Request Pricing";
  if (intent === "setup") return "Schedule a Demo";
  return "Request a Demo";
}

function demoForm(
  intent: DemoIntent,
  values: { name: string; email: string; hoa: string; phone: string; homes: string; message: string },
  error: string,
  sent: boolean,
): string {
  if (sent) {
    return `<section id="demo-form" class="pitch-section" aria-labelledby="demo-title">
      <div class="wrap">
        <div class="panel pitch-form">
          <h2 id="demo-title">Request received</h2>
          <p>Thanks. Your request was sent. We will reply by email.</p>
          <p><a class="button secondary" href="/bring-this-to-your-hoa#demo-form">Send another request</a></p>
        </div>
      </div>
    </section>`;
  }
  return `<section id="demo-form" class="pitch-section" aria-labelledby="demo-title">
      <div class="wrap">
        <div class="panel pitch-form">
          <p class="kicker" id="demo-intent-label">${intentLabel(intent)}</p>
          <h2 id="demo-title">Tell us about your community</h2>
          <p>Share a few details and we will reply by email.</p>
          ${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
          <form class="fields" method="post" action="/bring-this-to-your-hoa">
            <label class="hp">Company<input type="text" name="company" tabindex="-1" autocomplete="off"></label>
            <input type="hidden" name="intent" value="${esc(intent)}">
            <label>Name<input type="text" name="name" autocomplete="name" maxlength="120" required value="${esc(values.name)}"></label>
            <label>Email<input type="email" name="email" autocomplete="email" maxlength="200" required value="${esc(values.email)}"></label>
            <label>HOA / community name<input type="text" name="hoa" maxlength="160" required value="${esc(values.hoa)}"></label>
            <label>Phone, optional<input type="tel" name="phone" autocomplete="tel" maxlength="40" value="${esc(values.phone)}"></label>
            <label>Number of homes, optional<input type="text" name="homes" inputmode="numeric" maxlength="6" value="${esc(values.homes)}"></label>
            <label>Message<textarea name="message" maxlength="2000" required>${esc(values.message)}</textarea></label>
            <button type="submit">Send request</button>
          </form>
        </div>
      </div>
    </section>`;
}

export function hoaPitchPage(options: PitchPageOptions = {}): string {
  const intent: DemoIntent = options.intent === "pricing" || options.intent === "setup" ? options.intent : "demo";
  const formValues = {
    name: options.values?.name ?? "",
    email: options.values?.email ?? "",
    hoa: options.values?.hoa ?? "",
    phone: options.values?.phone ?? "",
    homes: options.values?.homes ?? "",
    message: options.values?.message ?? "",
  };
  const features = [
    featureCard("document", ICONS.shield, "Secure Owner Portal", "A private, secure portal for homeowners."),
    featureCard(
      "document",
      ICONS.document,
      "Documents &amp; Governing Records",
      "Easily access governing documents, meeting minutes, and records.",
    ),
    featureCard("person", ICONS.account, "Owner Accounts", "View account details, history and statements, anytime."),
    featureCard("envelope", ICONS.card, "Online Payments", "Pay assessments online quickly and securely.", true),
    featureCard("megaphone", ICONS.megaphone, "Announcements &amp; Notices", "Keep homeowners informed with important updates."),
    featureCard(
      "envelope",
      ICONS.chat,
      "Requests &amp; Communication",
      "Submit and track requests with easy communication tools.",
    ),
    featureCard("person", ICONS.people, "Owner Directory", "A modern, searchable association directory (optional).", true),
    featureCard("document", ICONS.gear, "Board &amp; Admin Tools", "Powerful tools for board members and community managers."),
  ].join("");

  const checks = [
    "Property and account details",
    "Association documents",
    "Latest community updates",
    "Requests and contact tools",
  ]
    .map((item) => `<li>${ICONS.check}<span>${item}</span></li>`)
    .join("");

  const board = [
    boardPoint(ICONS.upload, "Upload once.", "Store documents, notices and records in one place."),
    boardPoint(ICONS.megaphone, "Keep everyone informed.", "Send announcements and updates instantly to homeowners."),
    boardPoint(ICONS.clipboard, "Track requests.", "See status without extra emails or spreadsheets."),
    boardPoint(ICONS.lock, "Control access.", "Give the right people the right information."),
  ].join("");

  const prices = [
    priceCard({
      title: "Core Portal",
      price: "$99/month",
      intro: "Includes the core homeowner portal tools your association needs.",
      items: [
        "Secure owner portal",
        "Documents &amp; records",
        "Announcements &amp; notices",
        "Owner accounts",
        "Requests &amp; communication",
      ],
      intent: "pricing",
      label: "Request Pricing",
    }),
    priceCard({
      title: "Core Portal + Upgrades",
      popular: true,
      intro: "Add optional tools to fit your community's needs.",
      items: [
        "AI document chatbot",
        "Online payments",
        "Text alerts / SMS notices",
        "Violation tracking",
        "Amenity reservations",
      ],
      intent: "pricing",
      label: "Request Pricing",
    }),
    priceCard({
      title: "Custom Setup",
      intro: "For communities with imports, custom workflows, or special needs.",
      items: [
        "One-time import assistance",
        "Custom workflows",
        "Third-party integrations",
        "Special feature requests",
        "Dedicated setup support",
      ],
      intent: "setup",
      label: "Schedule a Demo",
    }),
  ].join("");

  const rows = [
    featureRow("Secure Owner Portal", "Included", "Private sign-in for homeowners."),
    featureRow("Documents &amp; Records", "Included", "Governing documents, meeting minutes, and records."),
    featureRow("Announcements &amp; Notices", "Included", "News, meetings, and notices from the board."),
    featureRow("Email Notifications", "Included", "The board can email homeowners about announcements, events, documents, and notices."),
    featureRow("Owner Accounts", "Included", "Balances, invoices, and recorded payments."),
    featureRow("Requests &amp; Communication", "Included", "Private messages to the board."),
    featureRow("Board &amp; Admin Tools", "Included", "Roster, ledger, documents, news, and messages."),
    featureRow("Owner Directory", "Coming Soon", "A searchable homeowner directory is not available yet."),
    featureRow("Pay Assessments Online", "Coming Soon", "Card and ACH payments are not available yet."),
    featureRow("AI Document Chatbot", "Coming Soon", "The document assistant does not answer questions yet."),
    featureRow("Text Alerts / SMS Notices", "Coming Soon", "The portal does not send text messages yet."),
    featureRow("Violation Tracking", "Coming Soon", "Violations are not tracked in the portal yet."),
    featureRow("Amenity Reservations", "Coming Soon", "Homeowners cannot reserve amenities yet."),
    featureRow("Accounting Integrations", "Coming Soon", "No connection to accounting software yet."),
    featureRow("Meeting &amp; Notice Compliance Tools", "Coming Soon", "State compliance tools are not included yet."),
    featureRow(
      "Community Branding",
      "Coming Soon",
      "The dashboard shows the association name. A logo for each association is a later step.",
    ),
  ].join("");

  const soon = [
    soonCard(ICONS.spark, "AI Document Assistant", "Get instant answers from your governing documents."),
    soonCard(ICONS.clipboard, "Violation Tracking", "Track, manage, and resolve violations more easily."),
    soonCard(ICONS.bell, "Text Notifications", "Send important updates by text message."),
    soonCard(ICONS.house, "Amenity Reservations", "Let homeowners easily reserve community amenities."),
  ].join("");

  const faqs = [
    faqItem(
      "Can you import our existing owner list?",
      "Yes. An administrator can import a CSV file of owners. The columns include email, name, lot number, and street address. Optional columns cover role, administrator access, phone, mailing address, a second owner, and a starting balance. Importing the same lot again updates that person and does not add a second opening balance.",
    ),
    faqItem(
      "Can homeowners pay assessments online?",
      "Not yet. Homeowners can view balances, invoices, and payments the board has recorded. The portal does not accept card or ACH payments. Online payments are coming soon.",
    ),
    faqItem(
      "Can multiple board members have administrator access?",
      "Yes. Several people can have administrator access at the same time. Officers have edit access, and a board member or homeowner can be given it too. The association keeps one master admin, who cannot be deleted and must keep edit access. Other admins can be added or changed.",
    ),
  ].join("");

  return `<nav class="pitch-jump wrap" aria-label="On this page">
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="#coming-soon">Coming Soon</a>
      <a href="#faq">FAQs</a>
      ${requestLink("demo", "Request a Demo")}
    </nav>
    <section class="pitch-hero" aria-labelledby="pitch-title">
      <div class="wrap pitch-hero-grid">
        <div class="pitch-hero-copy">
          <h1 id="pitch-title">Bring This to Your HOA</h1>
          <span class="rule pitch-rule-left" aria-hidden="true"></span>
          <p class="pitch-sub">A simple, secure homeowner portal built for real community associations.</p>
          <p>Give your homeowners one place for documents, announcements, account information, requests, community resources, and more, all in a modern, easy-to-use portal.</p>
          <p class="actions">
            ${requestLink("demo", "Request a Demo")}
            <a class="button secondary" href="#features">See Features</a>
          </p>
          <p class="muted">This platform powers the Tango Mar homeowner portal you're viewing now.</p>
        </div>
        <div class="pitch-devices">
          <figure class="pitch-laptop">
            <div class="pitch-laptop-bezel">
              <img src="${SHOT_DESKTOP}" alt="Sample homeowner dashboard on a desktop screen, signed in as Jennifer Hale, a fictional owner" width="1440" height="900">
            </div>
            <div class="pitch-laptop-base" aria-hidden="true"></div>
          </figure>
          <figure class="pitch-phone">
              <img src="${SHOT_PHONE}" alt="Sample homeowner dashboard at phone width, signed in as Jennifer Hale, a fictional owner" width="430" height="844">
          </figure>
        </div>
      </div>
    </section>
    <section id="features" class="pitch-section" aria-labelledby="features-title">
      <div class="wrap pitch-center">
        <h2 id="features-title">Everything Your Association Needs in One Place</h2>
        <span class="rule" aria-hidden="true"></span>
        <p class="home-lead">A complete set of tools to keep your community informed, organized, and connected.</p>
        <div class="home-cards">${features}</div>
      </div>
    </section>
    <section class="pitch-section" aria-labelledby="homeowners-title">
      <div class="wrap pitch-see-grid">
        <figure class="pitch-shot" id="sample-dashboard">
          <a href="${SHOT_FULL}" data-sample>
            <img src="${SHOT_FULL}" alt="Full sample homeowner dashboard for Jennifer Hale, a fictional owner with demo data only" width="1280" height="1661">
          </a>
        </figure>
        <div>
          <h2 id="homeowners-title">See What Homeowners See</h2>
          <span class="rule pitch-rule-left" aria-hidden="true"></span>
          <p class="pitch-sub">Simple for homeowners.</p>
          <ul class="pitch-checks">${checks}</ul>
          <p class="actions">
            <a class="button" href="#sample-dashboard" data-sample>View Sample Dashboard</a>
          </p>
          <p class="muted">Fictional demo owner. No real names, addresses, or balances.</p>
        </div>
      </div>
    </section>
    <section class="pitch-board pitch-section" aria-labelledby="board-title">
      <div class="wrap">
        <h2 id="board-title">Built for the Board, Too</h2>
        <span class="rule pitch-rule-left" aria-hidden="true"></span>
        <p class="pitch-sub">Less email. Fewer repeated questions. Better organization.</p>
        <div class="pitch-board-grid">${board}</div>
      </div>
    </section>
    <section id="pricing" class="pitch-section" aria-labelledby="pricing-title">
      <div class="wrap pitch-center">
        <h2 id="pricing-title">Simple Pricing, Clear Features</h2>
        <span class="rule" aria-hidden="true"></span>
        <p class="home-lead">Transparent pricing for real communities. No hidden fees.</p>
        <div class="pitch-prices">${prices}</div>
      </div>
    </section>
    <section class="pitch-section" aria-labelledby="platform-title">
      <div class="wrap">
        <h2 id="platform-title">Platform Features</h2>
        <span class="rule pitch-rule-left" aria-hidden="true"></span>
        <div class="panel pitch-table-wrap">
          <table>
            <thead><tr><th>Feature</th><th>Status</th><th>Notes</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </section>
    <section id="coming-soon" class="pitch-section" aria-labelledby="soon-title">
      <div class="wrap pitch-center">
        <h2 id="soon-title">We're Just Getting Started</h2>
        <span class="rule" aria-hidden="true"></span>
        <p class="home-lead">More powerful features are on the way.</p>
        <div class="pitch-soon">${soon}</div>
      </div>
    </section>
    <section id="faq" class="pitch-section pitch-faq" aria-labelledby="faq-title">
      <div class="wrap">
        <div class="pitch-center">
          <h2 id="faq-title">Frequently Asked Questions</h2>
          <span class="rule" aria-hidden="true"></span>
        </div>
        <div class="stack">${faqs}</div>
      </div>
    </section>
    ${demoForm(intent, formValues, options.error ?? "", Boolean(options.sent))}
    <dialog class="pitch-dialog" id="sample-dialog" aria-label="Sample homeowner dashboard">
      <form method="dialog" class="pitch-dialog-bar">
        <p>Sample dashboard. Demo data only.</p>
        <button type="submit" class="secondary">Close</button>
      </form>
      <img src="${SHOT_FULL}" alt="Full sample homeowner dashboard for Jennifer Hale, a fictional owner with demo data only">
    </dialog>
    <script src="/bring/sample-dashboard.js" defer></script>`;
}
