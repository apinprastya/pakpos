import { buildItems, fuzzyScore, rankItems, recentItems, scoreItem, type SearchItem } from "./search";
import { col, folder, makeEnv, makeExampleSummary, req } from "@/test/fixtures";
import { emptyRequest } from "@/lib/model";
import type { Tab } from "@/stores/tabs";

const tree = [
  col("c1", "Users API", [
    folder("f1", "Admin", [req("r2", "Delete user", "DELETE", "{{baseUrl}}/users/:id")]),
    req("r1", "List users", "GET", "{{baseUrl}}/users"),
  ]),
  col("c2", "Orders", [req("r3", "Refund", "POST", "https://shop/orders/refund")]),
];

const tab = (id: string, patch: Partial<Tab> = {}): Tab => ({
  id,
  request: { ...emptyRequest(), name: "Draft", url: "https://draft" },
  saved: null,
  parentId: "",
  workspaceId: "",
  sendId: null,
  result: null,
  doc: null,
  ...patch,
});

function items(): SearchItem[] {
  return buildItems({
    collections: tree,
    environments: [makeEnv("e1", "Development"), makeEnv("e2", "Production")],
    hasWorkspace: true,
    examples: [makeExampleSummary("x1", "r1", { name: "Empty page" }), makeExampleSummary("x9", "gone")],
    tabs: [
      tab("t1"),
      tab("t2", {
        doc: { kind: "globals", targetId: "", name: "Globals", draft: null, saved: null, missing: false },
      }),
    ],
  });
}

describe("buildItems", () => {
  it("lists the tree with breadcrumbs, environments, globals, examples and tabs", () => {
    const all = items();
    const byValue = new Map(all.map((i) => [i.value, i]));
    expect(byValue.get("collection:c1")).toMatchObject({ kind: "collection", label: "Users API", path: "" });
    expect(byValue.get("folder:f1")).toMatchObject({ kind: "folder", path: "Users API" });
    expect(byValue.get("request:r2")).toMatchObject({
      method: "DELETE",
      url: "{{baseUrl}}/users/:id",
      path: "Users API › Admin",
    });
    expect(byValue.get("request:r1")?.path).toBe("Users API");
    expect(byValue.get("globals")).toMatchObject({ kind: "globals", label: "Globals" });
    expect(byValue.get("environment:e2")?.label).toBe("Production");
    expect(byValue.get("example:x1")).toMatchObject({
      label: "Example: Empty page — List users",
      requestId: "r1",
      path: "Users API",
    });
    // Examples of requests that aren't in the tree are left out.
    expect(byValue.has("example:x9")).toBe(false);
    expect(byValue.get("tab:t1")).toMatchObject({
      kind: "tab",
      label: "Draft",
      url: "https://draft",
      method: "GET",
    });
    expect(byValue.get("tab:t2")).toMatchObject({ label: "Globals", url: undefined, method: undefined });
  });

  it("has no globals without a workspace", () => {
    const list = buildItems({
      collections: [],
      environments: [],
      hasWorkspace: false,
      examples: [],
      tabs: [tab("t1")],
    });
    expect(list.map((i) => i.value)).toEqual(["tab:t1"]);
  });
});

describe("fuzzyScore", () => {
  it.each([
    ["", "anything", true],
    ["user", "List users", true],
    ["lu", "List users", true],
    ["lsu", "List users", true],
    ["xyz", "List users", false],
    ["usersz", "users", false],
  ])("%s in %s matches: %s", (q, text, ok) => {
    expect(fuzzyScore(q, text) !== null).toBe(ok);
  });

  it("ranks substrings above scattered letters, word starts above the middle", () => {
    const prefix = fuzzyScore("list", "List users")!;
    const word = fuzzyScore("users", "List users")!;
    const middle = fuzzyScore("ser", "List users")!;
    const scattered = fuzzyScore("lsr", "List users")!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(scattered);
    expect(fuzzyScore("lu", "List users")!).toBeGreaterThan(fuzzyScore("lu", "xlxxxxu")!);
  });
});

describe("scoreItem and rankItems", () => {
  it("matches every word against the name, path or URL", () => {
    const all = items();
    const r2 = all.find((i) => i.value === "request:r2")!;
    expect(scoreItem(r2, "admin delete")).not.toBeNull();
    expect(scoreItem(r2, "baseUrl")).not.toBeNull();
    expect(scoreItem(r2, "orders")).toBeNull();
    expect(scoreItem(r2, "  ")).toEqual({ score: 0, inName: false });
  });

  it("puts name matches first, then recent items, then by score", () => {
    const all = items();
    const ranked = rankItems(all, "users", []).map((i) => i.value);
    // Names containing the query come before items matched by path or URL only.
    expect(ranked.slice(0, 3)).toEqual(expect.arrayContaining(["collection:c1", "request:r1"]));
    expect(ranked.indexOf("request:r2")).toBeGreaterThan(ranked.indexOf("request:r1"));

    const withRecent = rankItems(all, "users", ["request:r1"]).map((i) => i.value);
    expect(withRecent[0]).toBe("request:r1");
    expect(rankItems(all, "users", [], 1)).toHaveLength(1);
    expect(rankItems(all, "nothing-like-it", [])).toEqual([]);
  });

  it("keeps recent items that still exist, newest first, without tabs", () => {
    const all = items();
    expect(
      recentItems(all, ["folder:f1", "request:gone", "tab:t1", "environment:e1"]).map((i) => i.value),
    ).toEqual(["folder:f1", "environment:e1"]);
    expect(recentItems(all, ["folder:f1", "environment:e1"], 1)).toHaveLength(1);
  });
});
