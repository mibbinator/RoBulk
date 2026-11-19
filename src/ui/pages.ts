// Where on create.roblox.com RoBulk is offered, and where it can open.
//
// The button shows on every Creator Dashboard page so it's easy to find, but
// RoBulk works on creations (the clothing store's avatar items, or an
// experience's passes and products), so it only opens from the Creations
// section. Anywhere else, clicking it explains where to go instead.

export const CREATIONS_URL = "https://create.roblox.com/dashboard/creations";

/** A Creator Dashboard page, where the RoBulk button shows. */
export const isDashboardPath = (path: string) => path === "/dashboard" || path.startsWith("/dashboard/");

/** The Creations section (avatar items, experiences and their passes and products), where RoBulk opens. */
export const opensHere = (path: string) => path === "/dashboard/creations" || path.startsWith("/dashboard/creations/");
