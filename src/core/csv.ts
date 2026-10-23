import type { SellableItem } from "../api/types";
import { CATEGORIES, categoryFor } from "./categories";
import type { Edit } from "./edits";

// Spreadsheet export/import. Exported files round-trip: edit the price,
// on_sale, name or description columns in Excel / Google Sheets and import
// the file to stage those changes (nothing is saved until you click Save).

const COLUMNS = ["type", "id", "category", "name", "price", "on_sale", "managed_pricing", "description"] as const;

const TYPE_LABEL = { avatar: "avatar", gamePass: "game_pass", devProduct: "dev_product" } as const;
const LABEL_TYPE: Record<string, SellableItem["kind"]> = { avatar: "avatar", game_pass: "gamePass", dev_product: "devProduct" };

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(items: SellableItem[]): string {
  const rows = items.map((item) => {
    const category = CATEGORIES.find((c) => c.id === categoryFor(item))?.label ?? "";
    return [
      TYPE_LABEL[item.kind],
      String(item.id),
      category,
      item.name,
      item.price == null ? "" : String(item.price),
      item.onSale ? "yes" : "no",
      item.managedPricing == null ? "" : item.managedPricing ? "yes" : "no",
      item.description ?? "",
    ].map(escapeCell);
  });
  return [COLUMNS.join(","), ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
}

/** RFC 4180-style parser: quoted cells, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface CsvImportResult {
  patches: { item: SellableItem; patch: Edit }[];
  /** Human-readable problems, one per skipped row or cell. */
  warnings: string[];
}

const parseBool = (v: string) => {
  const s = v.trim().toLowerCase();
  if (["yes", "y", "true", "1", "on"].includes(s)) return true;
  if (["no", "n", "false", "0", "off"].includes(s)) return false;
  return undefined;
};

export function csvToPatches(text: string, items: SellableItem[]): CsvImportResult {
  const [header, ...rows] = parseCsv(text);
  const warnings: string[] = [];
  if (!header) return { patches: [], warnings: ["The file is empty."] };
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const idx = { type: col("type"), id: col("id"), name: col("name"), price: col("price"), onSale: col("on_sale"), managed: col("managed_pricing"), description: col("description") };
  if (idx.id < 0) return { patches: [], warnings: ['The file needs an "id" column. Export a file from RoBulk to see the format.'] };

  const byKey = new Map(items.map((i) => [i.key, i]));
  const patches: CsvImportResult["patches"] = [];
  rows.forEach((row, r) => {
    const line = r + 2;
    const kind = idx.type >= 0 ? LABEL_TYPE[row[idx.type]?.trim()] : "avatar";
    const item = kind && byKey.get(`${kind}:${row[idx.id]?.trim()}`);
    if (!item) {
      warnings.push(`Row ${line}: no loaded item matches this type and id, so it was skipped.`);
      return;
    }
    const patch: Edit = {};
    if (idx.price >= 0 && row[idx.price]?.trim() !== "") {
      const price = Number(row[idx.price]);
      if (Number.isInteger(price) && price >= 0) patch.price = price;
      else warnings.push(`Row ${line}: "${row[idx.price]}" isn't a valid price.`);
    }
    if (idx.onSale >= 0 && row[idx.onSale]?.trim() !== "") {
      const onSale = parseBool(row[idx.onSale]);
      if (onSale !== undefined) patch.onSale = onSale;
      else warnings.push(`Row ${line}: on_sale should be yes or no.`);
    }
    if (idx.managed >= 0 && item.managedPricing !== undefined && row[idx.managed]?.trim() !== "") {
      const managed = parseBool(row[idx.managed]);
      if (managed !== undefined) patch.managedPricing = managed;
    }
    if (idx.name >= 0 && row[idx.name]?.trim()) patch.name = row[idx.name].trim();
    if (idx.description >= 0 && row[idx.description] !== undefined) patch.description = row[idx.description];
    patches.push({ item, patch });
  });
  return { patches, warnings };
}
