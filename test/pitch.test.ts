import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hoaPitchPage } from "../src/views/pitch";
import { siteFooter } from "../src/views/layout";

const PATH = "/bring-this-to-your-hoa";

function pageText(html: string): string {
  const start = html.indexOf('<nav class="pitch-jump');
  const end = html.indexOf('<footer class="home-footer">');
  return html.slice(start, end);
}

describe("bring this to your HOA", () => {
  it("is a public page with the mockup sections and a footer link", async () => {
    const app = createApp();
    const env = {} as Env;
    const response = await app.request(`http://localhost${PATH}`, {}, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Bring This to Your HOA · Tango Mar</title>");
    expect(html).toContain("<h1 id=\"pitch-title\">Bring This to Your HOA</h1>");
    expect(html).toContain("A simple, secure homeowner portal built for real community associations.");
    expect(html).toContain("This platform powers the Tango Mar homeowner portal you're viewing now.");
    expect(html).toContain('href="#features">See Features</a>');
    expect(html).toContain('href="#sample-dashboard"');
    expect(html).toContain("View Sample Dashboard");
    expect(html).toContain("Everything Your Association Needs in One Place");
    expect(html).toContain("See What Homeowners See");
    expect(html).toContain("Built for the Board, Too");
    expect(html).toContain("Simple Pricing, Clear Features");
    expect(html).toContain("Transparent pricing for real communities. No hidden fees.");
    expect(html).toContain("$99/month");
    expect(html).toContain("Core Portal + Upgrades");
    expect(html).toContain("Most popular");
    expect(html).toContain("AI document chatbot");
    expect(html).toContain("Text alerts / SMS notices");
    expect(html).toContain("One-time import assistance");
    expect(html).toContain("Dedicated setup support");
    expect(html).toContain("Platform Features");
    expect(html).toContain("We're Just Getting Started");
    expect(html).toContain("Frequently Asked Questions");
    expect(html).toContain("<details class=\"faq panel\">");
    expect(html).toContain('class="pitch"');
    expect(html).toContain(siteFooter());
    expect(html).not.toContain("/tango-mar-boardwalk.png");
    expect(html).not.toContain("/tango-mar-dunes.webp");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
    expect(pageText(html)).not.toContain("palm");

    const home = await app.request("http://localhost/", {}, env);
    expect(await home.text()).toContain(`href="${PATH}">Bring This to Your HOA</a>`);
  });

  it("asks Marc for a demo by email and answers from the current product", () => {
    const html = hoaPitchPage();
    expect(html).toContain("mailto:marc@whpinc.com?subject=Demo%20request%20for%20Bring%20This%20to%20Your%20HOA");
    expect(html).toContain("mailto:marc@whpinc.com?subject=Pricing%20request%20for%20Bring%20This%20to%20Your%20HOA");
    expect(html).toContain("mailto:marc@whpinc.com?subject=Custom%20setup%20demo%20for%20Bring%20This%20to%20Your%20HOA");
    expect(html).toContain("An administrator can import a CSV file of owners.");
    expect(html).toContain("The portal does not accept card or ACH payments.");
    expect(html).toContain("Several people can have administrator access at the same time.");
    expect(html).toContain("mytangomar.com");
    expect(html).toContain("It does not replace a management company.");
    expect(html).toContain('src="/bring/dashboard-desktop.webp"');
    expect(html).toContain('src="/bring/dashboard-phone.webp"');
    expect(html).toContain('src="/bring/dashboard-full.webp"');
    expect(html).toContain('src="/bring/sample-dashboard.js"');
    for (const file of ["public/bring/dashboard-desktop.webp", "public/bring/dashboard-phone.webp", "public/bring/dashboard-full.webp"]) {
      const bytes = readFileSync(file, "utf8");
      expect(bytes.startsWith("RIFF")).toBe(true);
      expect(bytes.length).toBeGreaterThan(1000);
      expect(bytes.length).toBeLessThan(350_000);
    }
  });
});
