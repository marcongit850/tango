import { isIsoDate } from "./dates";
import type { DocumentCategory } from "../types";

export const DOCUMENT_CATEGORIES: readonly { id: DocumentCategory; label: string }[] = [
  { id: "covenants", label: "Covenants and restrictions" },
  { id: "bylaws", label: "Bylaws" },
  { id: "guidelines", label: "Architectural guidelines" },
  { id: "rules", label: "Rules and regulations" },
  { id: "minutes", label: "Meeting Minutes / Agendas" },
  { id: "budgets", label: "Budgets" },
  { id: "forms", label: "Forms and applications" },
  { id: "insurance_docs", label: "Insurance" },
  { id: "insurance", label: "Other" },
];

/** Categories that already fit the original documents check constraint. */
const LEGACY_DOCUMENT_CATEGORIES = new Set<string>([
  "covenants",
  "bylaws",
  "guidelines",
  "rules",
  "minutes",
  "budgets",
  "forms",
  "insurance",
]);

const FOLDER_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9 .'_-]{0,38}[A-Za-z0-9])?$/;

/** Categories that file a dated document under that year. Others stay flat. */
const YEAR_FOLDER_CATEGORIES = new Set<string>(["minutes", "budgets", "insurance_docs"]);

export function categoryUsesYearFolders(category: string): boolean {
  return YEAR_FOLDER_CATEGORIES.has(category);
}

export function normalizeDocumentDate(raw: string): { ok: true; date: string } | { ok: false; error: string } {
  const date = raw.trim();
  if (!date) return { ok: true, date: "" };
  if (!isIsoDate(date)) return { ok: false, error: "Enter a valid date, or leave it blank." };
  return { ok: true, date };
}

/**
 * Meeting Minutes, Budgets, and Insurance use the document date's year as the folder.
 * A typed subfolder such as January stays under that year. Other categories keep the typed folder.
 */
export function placeDocumentFolder(category: string, folder: string, documentDate: string): string {
  if (!categoryUsesYearFolders(category) || !isIsoDate(documentDate)) return folder;
  const year = documentDate.slice(0, 4);
  if (!folder) return year;
  const parts = folder.split("/");
  if (parts[0] === year) return folder;
  if (/^\d{4}$/.test(parts[0] ?? "")) {
    parts[0] = year;
    return parts.join("/");
  }
  return `${year}/${folder}`;
}

export function categoryLabel(category: string): string {
  return DOCUMENT_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}

export function isDocumentCategory(value: string): value is DocumentCategory {
  return DOCUMENT_CATEGORIES.some((item) => item.id === value);
}

export function isLegacyDocumentCategory(value: string): boolean {
  return LEGACY_DOCUMENT_CATEGORIES.has(value);
}

export function normalizeFolder(raw: string): { ok: true; folder: string } | { ok: false; error: string } {
  const parts = raw
    .trim()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return { ok: true, folder: "" };
  if (parts.length > 4) return { ok: false, error: "Use at most 4 folders." };
  if (parts.some((part) => !FOLDER_SEGMENT.test(part))) {
    return { ok: false, error: "Use letters, numbers, or a year such as 2024. Separate folders with a slash." };
  }
  return { ok: true, folder: parts.join("/") };
}

export type FolderGroup<T> = {
  name: string;
  path: string;
  files: T[];
  children: FolderGroup<T>[];
  count: number;
};

export type CategoryGroup<T> = {
  id: string;
  label: string;
  files: T[];
  children: FolderGroup<T>[];
  count: number;
};

type FolderDraft<T> = {
  name: string;
  path: string;
  files: T[];
  childMap: Map<string, FolderDraft<T>>;
};

function compareFolderNames(a: string, b: string): number {
  const yearA = /^\d{4}$/.test(a);
  const yearB = /^\d{4}$/.test(b);
  if (yearA && yearB) return Number(b) - Number(a);
  if (yearA !== yearB) return yearA ? -1 : 1;
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

function sortByTitle<T extends { title: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => a.title.localeCompare(b.title, "en", { numeric: true, sensitivity: "base" }));
}

function finalizeFolder<T extends { title: string }>(draft: FolderDraft<T>): FolderGroup<T> {
  const children = [...draft.childMap.values()].sort((a, b) => compareFolderNames(a.name, b.name)).map((child) => finalizeFolder(child));
  return {
    name: draft.name,
    path: draft.path,
    files: sortByTitle(draft.files),
    children,
    count: draft.files.length + children.reduce((sum, child) => sum + child.count, 0),
  };
}

function folderParts(folder: string | null | undefined): string[] {
  return (folder ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Groups documents into category folders, then optional subfolders.
 * A blank folder stays directly in the category. Categories with no subfolders
 * have an empty children list so the page can open straight to the files.
 * Every known category is included, even when it has no files yet.
 */
export function groupDocuments<T extends { category: string; title: string; folder?: string | null }>(
  documents: readonly T[],
): CategoryGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const document of documents) {
    const list = buckets.get(document.category);
    if (list) list.push(document);
    else buckets.set(document.category, [document]);
  }
  const known = new Set<string>(DOCUMENT_CATEGORIES.map((item) => item.id));
  const ids = [
    ...DOCUMENT_CATEGORIES.map((item) => item.id),
    ...[...buckets.keys()].filter((id) => !known.has(id)).sort((a, b) => a.localeCompare(b)),
  ];
  return ids.map((id) => {
    const docs = buckets.get(id) ?? [];
    const files: T[] = [];
    const childMap = new Map<string, FolderDraft<T>>();
    for (const document of docs) {
      const parts = folderParts(document.folder);
      if (!parts.length) {
        files.push(document);
        continue;
      }
      let map = childMap;
      let path = "";
      let node: FolderDraft<T> | undefined;
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        node = map.get(part);
        if (!node) {
          node = { name: part, path, files: [], childMap: new Map() };
          map.set(part, node);
        }
        map = node.childMap;
      }
      node?.files.push(document);
    }
    const children = [...childMap.values()].sort((a, b) => compareFolderNames(a.name, b.name)).map((child) => finalizeFolder(child));
    return {
      id,
      label: categoryLabel(id),
      files: sortByTitle(files),
      children,
      count: files.length + children.reduce((sum, child) => sum + child.count, 0),
    };
  });
}
