import { describe, expect, it } from "vitest";
import { dashboardGroupId } from "./dashboardGroup";

const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

describe("dashboardGroupId", () => {
  it("uses the group selected in the dashboard's switcher", () => {
    expect(dashboardGroupId(7, "", storage({ "creatorHubGroup.7": "4861395" }))).toBe(4861395);
  });

  it("prefers a group in the page address", () => {
    expect(dashboardGroupId(7, "?activeTab=Shirt&groupId=123", storage({ "creatorHubGroup.7": "4861395" }))).toBe(123);
  });

  it("returns null when the user's own creations are selected", () => {
    expect(dashboardGroupId(7, "", storage({ "creatorHubGroup.7": "null" }))).toBeNull();
    expect(dashboardGroupId(7, "", storage({}))).toBeNull();
  });

  it("only reads the signed-in user's selection", () => {
    expect(dashboardGroupId(7, "", storage({ "creatorHubGroup.8": "4861395" }))).toBeNull();
  });

  it("tolerates odd values", () => {
    expect(dashboardGroupId(7, "", storage({ "creatorHubGroup.7": '{"id":55}' }))).toBe(55);
    expect(dashboardGroupId(7, "", storage({ "creatorHubGroup.7": "not json" }))).toBeNull();
    expect(dashboardGroupId(7, "", null)).toBeNull();
  });
});
