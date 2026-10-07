const ALLOWED_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_CSV_BYTES = 1024 * 1024;

export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "document";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || "document";
}

export function noticeFileProblem(file: File): string | null {
  if (!contentTypeForUpload(file)) return "Upload a PDF, text file, image, or Word document.";
  if (file.size > MAX_DOCUMENT_BYTES) return "Files must be 8 MB or smaller.";
  return null;
}

export function contentTypeForUpload(file: File): string | null {
  const reported = file.type.split(";")[0].trim().toLowerCase();
  if (ALLOWED_TYPES.has(reported)) return reported === "text/plain" ? "text/plain; charset=utf-8" : reported;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mapped = EXTENSION_TYPES[extension];
  if (!mapped) return null;
  return mapped === "text/plain" ? "text/plain; charset=utf-8" : mapped;
}

const BROWSER_VIEWABLE = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export function isBrowserViewable(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return BROWSER_VIEWABLE.has(base);
}

function dispositionFilename(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "").replaceAll('"', "");
  return ascii || "document";
}

export function documentContentDisposition(filename: string, contentType: string, download: boolean): string {
  const mode = !download && isBrowserViewable(contentType) ? "inline" : "attachment";
  return `${mode}; filename="${dispositionFilename(filename)}"`;
}

export function applyDocumentResponseHeaders(
  headers: Headers,
  file: { filename: string; contentType: string; download: boolean },
): void {
  if (!headers.has("Content-Type")) headers.set("Content-Type", file.contentType);
  const served = headers.get("Content-Type") || file.contentType;
  headers.set("Content-Disposition", documentContentDisposition(file.filename, served, file.download));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
}
