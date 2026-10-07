import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { privacyPage, termsPage } from "../src/views/legal";

function legalText(html: string): string {
  const start = html.indexOf('<article class="panel legal">');
  const end = html.indexOf("</article>", start);
  return html
    .slice(start, end)
    .replace(/>\s+</g, "><")
    .replace(/<h1>/g, "")
    .replace(/<\/h1>/g, "")
    .replace(/<h2>/g, "\n\n")
    .replace(/<\/h2>/g, "")
    .replace(/<p[^>]*>/g, "\n\n")
    .replace(/<\/p>/g, "")
    .replace(/<ul>/g, "\n")
    .replace(/<\/ul>/g, "")
    .replace(/<li>/g, "\n- ")
    .replace(/<\/li>/g, "")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fixture(name: string): string {
  return readFileSync(`test/fixtures/${name}`, "utf8").trim();
}

describe("legal pages", () => {
  it("uses the provided privacy policy wording", () => {
    const html = privacyPage();
    expect(html).toContain('<article class="panel legal">');
    expect(html).toContain("<h1>Privacy Policy</h1>");
    expect(html).toContain("Effective Date: October 6, 2026");
    expect(legalText(html)).toBe(fixture("privacy-policy.txt"));
    expect(html).toContain("Tango Mar Property Owners Association, Inc.");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
  });

  it("uses the provided terms of use wording", () => {
    const html = termsPage();
    expect(html).toContain("<h1>Terms of Use</h1>");
    expect(html).toContain("Effective Date: October 6, 2026");
    expect(legalText(html)).toBe(fixture("terms-of-use.txt"));
    expect(html).toContain("laws of the State of Florida");
  });

  it("serves both pages to logged-out visitors and links them from the footer", async () => {
    const app = createApp();
    const env = {} as Env;

    const home = await app.request("http://localhost/", {}, env);
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('<footer class="home-footer">');
    expect(homeHtml).toContain('href="/privacy">Privacy Policy</a>');
    expect(homeHtml).toContain('href="/terms">Terms of Use</a>');
    expect(homeHtml).toContain("© 2026 Tango Mar Property Owners Association");
    expect(homeHtml).toContain('href="/a/tango-mar/faq">FAQs</a>');
    expect(homeHtml).not.toContain('<footer class="site-footer wrap">');
    expect(homeHtml).not.toContain(">Support</a>");
    expect(homeHtml).not.toContain("A beach neighborhood in Miramar Beach, Walton County, Florida.");
    expect(homeHtml).toContain(".panel.legal {\n  border-radius: 0;");

    const privacy = await app.request("http://localhost/privacy", {}, env);
    expect(privacy.status).toBe(200);
    const privacyHtml = await privacy.text();
    expect(privacyHtml).toContain("<title>Privacy Policy · Tango Mar</title>");
    expect(legalText(privacyHtml)).toBe(fixture("privacy-policy.txt"));
    expect(privacyHtml).toContain('<footer class="home-footer">');
    expect(privacyHtml).toContain('href="/privacy">Privacy Policy</a>');
    expect(privacyHtml).toContain('href="/terms">Terms of Use</a>');
    expect(privacyHtml).toContain('href="/a/tango-mar/dashboard">Dashboard</a>');
    expect(privacyHtml).not.toContain('<footer class="site-footer wrap">');
    const privacyNav = privacyHtml.slice(privacyHtml.indexOf("<nav>"), privacyHtml.indexOf("</nav>"));
    expect(privacyNav).toContain('href="/">Home</a>');
    expect(privacyNav).toContain("Resident login");
    expect(privacyNav).toContain("Request to join");
    expect(privacyNav).not.toContain("Dashboard");
    expect(privacyHtml).not.toContain(">Support</a>");
    expect(privacyHtml).toContain('class="panel legal"');

    const terms = await app.request("http://localhost/terms", {}, env);
    expect(terms.status).toBe(200);
    const termsHtml = await terms.text();
    expect(termsHtml).toContain("<title>Terms of Use · Tango Mar</title>");
    expect(legalText(termsHtml)).toBe(fixture("terms-of-use.txt"));
    const termsNav = termsHtml.slice(termsHtml.indexOf("<nav>"), termsHtml.indexOf("</nav>"));
    expect(termsNav).toContain('href="/">Home</a>');
    expect(termsNav).toContain("Resident login");
    expect(termsNav).not.toContain("Dashboard");
    expect(termsHtml).not.toContain(">Support</a>");
  });
});
