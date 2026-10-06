import type { DocumentCategory } from "../types";

export const DOCUMENT_CATEGORIES: readonly { id: DocumentCategory; label: string }[] = [
  { id: "covenants", label: "Covenants and restrictions" },
  { id: "bylaws", label: "Bylaws" },
  { id: "guidelines", label: "Architectural guidelines" },
  { id: "rules", label: "Rules and regulations" },
  { id: "minutes", label: "Meeting minutes" },
  { id: "budgets", label: "Budgets and financial reports" },
  { id: "forms", label: "Forms and applications" },
  { id: "insurance", label: "Insurance and other community documents" },
];

export function categoryLabel(category: string): string {
  return DOCUMENT_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}

export function isDocumentCategory(value: string): value is DocumentCategory {
  return DOCUMENT_CATEGORIES.some((item) => item.id === value);
}
