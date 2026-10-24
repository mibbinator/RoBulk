import { describe, expect, it } from "vitest";
import { addToFolder, createFolder, deleteFolder, folderNamesByItem, readFolders, removeFromFolder, renameFolder, writeFolders } from "./folders";
import { memoryStorage } from "./history";

describe("folders", () => {
  it("adds, removes, renames and deletes, without duplicates", () => {
    const created = createFolder([], "  Christmas set ", ["avatar:1", "avatar:1"]);
    const id = created.folder.id;
    expect(created.folder.name).toBe("Christmas set");
    expect(created.folder.itemKeys).toEqual(["avatar:1"]);
    let folders = addToFolder(created.folders, id, ["avatar:1", "avatar:2"]);
    folders = createFolder(folders, "Hats", ["avatar:2"]).folders;
    expect(folderNamesByItem(folders).get("avatar:2")).toEqual(["Christmas set", "Hats"]);
    folders = removeFromFolder(folders, id, ["avatar:1"]);
    folders = renameFolder(folders, id, "Winter");
    expect(folders[0]).toMatchObject({ name: "Winter", itemKeys: ["avatar:2"] });
    expect(deleteFolder(folders, id).map((f) => f.name)).toEqual(["Hats"]);
  });

  it("saves each creator's folders separately", async () => {
    const storage = memoryStorage();
    await writeFolders(storage, "Group:9", createFolder([], "Christmas set", ["avatar:1"]).folders);
    expect((await readFolders(storage, "Group:9")).map((f) => f.name)).toEqual(["Christmas set"]);
    expect(await readFolders(storage, "User:1")).toEqual([]);
    await writeFolders(storage, "Group:9", []);
    expect(await readFolders(storage, "Group:9")).toEqual([]);
  });
});
