import { describe, expect, it } from "vitest";
import { universeFromPath } from "./games";

describe("universeFromPath", () => {
  it("finds the experience on its Creator Dashboard pages", () => {
    expect(universeFromPath("/dashboard/creations/experiences/6401319371/overview")).toBe(6401319371);
    expect(universeFromPath("/dashboard/creations/experiences/42")).toBe(42);
    expect(universeFromPath("/dashboard/creations/experiences/42/monetization/passes")).toBe(42);
  });

  it("ignores other pages", () => {
    expect(universeFromPath("/dashboard/creations")).toBeNull();
    expect(universeFromPath("/dashboard/creations/catalog/123/configure")).toBeNull();
  });
});
