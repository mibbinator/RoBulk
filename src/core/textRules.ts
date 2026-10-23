// Bulk rename and description templates.
//
// Templates can use {name} (the current name), {n} (position in the
// selection, starting at 1), {price} and {id}.

export type TextOperation =
  | { kind: "template"; template: string }
  | { kind: "prefix"; text: string }
  | { kind: "suffix"; text: string }
  | { kind: "replace"; find: string; replaceWith: string; caseSensitive?: boolean };

export interface TemplateContext {
  current: string;
  /** The item's name (for description templates that mention it). */
  name: string;
  index: number;
  price: number | null;
  id: number;
}

function fill(template: string, ctx: TemplateContext): string {
  return template.replace(/\{(name|n|price|id|current)\}/g, (_, token: string) => {
    switch (token) {
      case "name":
        return ctx.name;
      case "current":
        return ctx.current;
      case "n":
        return String(ctx.index + 1);
      case "price":
        return ctx.price == null ? "" : String(ctx.price);
      default:
        return String(ctx.id);
    }
  });
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function applyTextOperation(op: TextOperation, ctx: TemplateContext): string {
  switch (op.kind) {
    case "template":
      return fill(op.template, ctx);
    case "prefix":
      return ctx.current.startsWith(op.text) ? ctx.current : op.text + ctx.current;
    case "suffix":
      return ctx.current.endsWith(op.text) ? ctx.current : ctx.current + op.text;
    case "replace":
      if (!op.find) return ctx.current;
      return ctx.current.replace(new RegExp(escapeRegExp(op.find), op.caseSensitive ? "g" : "gi"), op.replaceWith);
  }
}

/** Roblox item names are limited to 50 characters; descriptions to 1000. */
export const NAME_LIMIT = 50;
export const DESCRIPTION_LIMIT = 1000;
