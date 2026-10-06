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

export function contentTypeForUpload(file: File): string | null {
  const reported = file.type.split(";")[0].trim().toLowerCase();
  if (ALLOWED_TYPES.has(reported)) return reported === "text/plain" ? "text/plain; charset=utf-8" : reported;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mapped = EXTENSION_TYPES[extension];
  if (!mapped) return null;
  return mapped === "text/plain" ? "text/plain; charset=utf-8" : mapped;
}

export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "").replaceAll('"', "");
  return `attachment; filename="${ascii || "document"}"`;
}
