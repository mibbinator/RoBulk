import { describe, expect, it } from "vitest";
import { isDashboardPath, opensHere } from "./pages";

describe("isDashboardPath", () => {
  it("is true across the Creator Dashboard", () => {
    expect(isDashboardPath("/dashboard")).toBe(true);
    expect(isDashboardPath("/dashboard/creations")).toBe(true);
    expect(isDashboardPath("/dashboard/analytics/overview")).toBe(true);
  });

  it("is false elsewhere on create.roblox.com", () => {
    expect(isDashboardPath("/")).toBe(false);
    expect(isDashboardPath("/docs/reference")).toBe(false);
    expect(isDashboardPath("/dashboardish")).toBe(false);
  });
});

describe("opensHere", () => {
  it("opens in Creations, including an experience's pages", () => {
    expect(opensHere("/dashboard/creations")).toBe(true);
    expect(opensHere("/dashboard/creations/experiences/123/monetization/passes")).toBe(true);
    expect(opensHere("/dashboard/creations/experiences/123/developer-products")).toBe(true);
    expect(opensHere("/dashboard/creations/catalog/456/configure")).toBe(true);
  });

  it("doesn't open on other dashboard pages", () => {
    expect(opensHere("/dashboard")).toBe(false);
    expect(opensHere("/dashboard/analytics/overview")).toBe(false);
    expect(opensHere("/dashboard/group/roles")).toBe(false);
    expect(opensHere("/dashboard/creationsx")).toBe(false);
  });
});
