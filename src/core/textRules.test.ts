import { describe, expect, it } from "vitest";
import { applyTextOperation, type TemplateContext } from "./textRules";

const ctx: TemplateContext = { current: "Orange Suit", name: "Orange Suit", index: 2, price: 25, id: 123 };

describe("applyTextOperation", () => {
  it("fills templates", () => {
    expect(applyTextOperation({ kind: "template", template: "[VD] {name} #{n}" }, ctx)).toBe("[VD] Orange Suit #3");
    expect(applyTextOperation({ kind: "template", template: "{name} for R${price} (id {id})" }, ctx)).toBe(
      "Orange Suit for R$25 (id 123)",
    );
  });

  it("adds a prefix or suffix only once", () => {
    expect(applyTextOperation({ kind: "prefix", text: "[VD] " }, ctx)).toBe("[VD] Orange Suit");
    expect(applyTextOperation({ kind: "prefix", text: "[VD] " }, { ...ctx, current: "[VD] Orange Suit" })).toBe("[VD] Orange Suit");
    expect(applyTextOperation({ kind: "suffix", text: " [+]" }, ctx)).toBe("Orange Suit [+]");
  });

  it("finds and replaces, case-insensitively by default", () => {
    expect(applyTextOperation({ kind: "replace", find: "orange", replaceWith: "Blue" }, ctx)).toBe("Blue Suit");
    expect(applyTextOperation({ kind: "replace", find: "orange", replaceWith: "Blue", caseSensitive: true }, ctx)).toBe("Orange Suit");
    expect(applyTextOperation({ kind: "replace", find: "(", replaceWith: "x" }, { ...ctx, current: "a(b(" })).toBe("axbx");
  });

  it("can append to descriptions with {current}", () => {
    expect(applyTextOperation({ kind: "template", template: "{current}\n\nMore at our group!" }, { ...ctx, current: "Nice suit." })).toBe(
      "Nice suit.\n\nMore at our group!",
    );
  });
});
