import { ForbiddenError } from "./errors";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function paragraphs(text: string): string {
  return esc(text)
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replaceAll("\n", "<br>")}</p>`)
    .join("");
}

export function htmlResponse(body: string, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(body, { status, headers });
}

export function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

export function isHttps(url: string): boolean {
  return new URL(url).protocol === "https:";
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ForbiddenError();
  }
}
