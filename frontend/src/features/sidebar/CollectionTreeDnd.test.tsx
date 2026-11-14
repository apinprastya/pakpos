import { act, render, screen } from "@testing-library/react";
import type { DndContextProps } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CollectionNode } from "@/lib/model";
import { col, folder, req } from "@/test/fixtures";
import { useWorkspaceStore } from "@/stores/workspace";
import { CollectionTree } from "./CollectionTree";

// Real pointer drags need layout, which jsdom lacks: capture the handlers and call them directly.
const captured: { props: DndContextProps | null } = { props: null };
vi.mock("@dnd-kit/core", async (orig) => {
  const actual = await orig<typeof import("@dnd-kit/core")>();
  const React = await import("react");
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      captured.props = props;
      return React.createElement(actual.DndContext, props);
    },
  };
});

// Users[ List, Auth[ Login, Tokens[] ], Create ]  Orders[ Get ]  Empty[]
const cols: CollectionNode[] = [
  col("c1", "Users", [
    req("r1", "List"),
    folder("f1", "Auth", [req("r2", "Login", "POST"), folder("f2", "Tokens")]),
    req("r3", "Create", "POST"),
  ]),
  col("c2", "Orders", [req("r4", "Get")]),
  col("c3", "Empty"),
];

const dnd = () => captured.props!;
type EndEvent = Parameters<NonNullable<DndContextProps["onDragEnd"]>>[0];
type MoveEvent = Parameters<NonNullable<DndContextProps["onDragMove"]>>[0];
type StartEvent = Parameters<NonNullable<DndContextProps["onDragStart"]>>[0];

/** Every row is 20px high at top 100; `at` is where the pointer is within it (0..1). */
const ev = (active: string, over: string | null, at = 0.5) =>
  ({
    active: { id: active, rect: { current: { translated: null, initial: null } } },
    over: over
      ? { id: over, rect: { top: 100, height: 20, left: 0, width: 200, bottom: 120, right: 200 } }
      : null,
    activatorEvent: { clientY: 0 },
    delta: { x: 0, y: 100 + at * 20 },
  }) as unknown as EndEvent & MoveEvent;
const start = (active: string) => act(() => dnd().onDragStart!({ active: { id: active } } as StartEvent));

function setup() {
  useWorkspaceStore.setState({ collections: cols, status: "ready" });
  const store = useWorkspaceStore.getState();
  const moveRequest = vi.spyOn(store, "moveRequest").mockResolvedValue();
  const moveFolder = vi.spyOn(store, "moveFolder").mockResolvedValue();
  const reorderCollections = vi.spyOn(store, "reorderCollections").mockResolvedValue();
  const setExpanded = vi.fn();
  render(
    <TooltipProvider>
      <CollectionTree
        collections={cols}
        filtering={false}
        isExpanded={() => true}
        setExpanded={setExpanded}
        confirmDelete={() => {}}
      />
    </TooltipProvider>,
  );
  return { moveRequest, moveFolder, reorderCollections, setExpanded };
}

const row = (name: string) => screen.getByRole("treeitem", { name }).firstElementChild as HTMLElement;

describe("collection tree drag and drop", () => {
  it("moves a request before a request in a folder, showing where it will land", () => {
    const { moveRequest } = setup();
    start("r:r1");
    act(() => dnd().onDragMove!(ev("r:r1", "r:r2", 0.2)));
    expect(row("POST Login")).toHaveAttribute("data-drop", "before");
    act(() => dnd().onDragMove!(ev("r:r1", "r:r2", 0.2))); // same spot: nothing changes
    act(() => dnd().onDragMove!(ev("r:r1", "r:r2", 0.8)));
    expect(row("POST Login")).toHaveAttribute("data-drop", "after");
    act(() => dnd().onDragEnd!(ev("r:r1", "r:r2", 0.2)));
    expect(moveRequest).toHaveBeenCalledWith("r1", "f1", 0);
    expect(row("POST Login")).not.toHaveAttribute("data-drop");
  });

  it("drops into the middle of a folder or onto a collection, expanding the target", () => {
    const { moveRequest, moveFolder, setExpanded } = setup();
    start("r:r1");
    act(() => dnd().onDragMove!(ev("r:r1", "f:f2", 0.5)));
    expect(row("Tokens")).toHaveAttribute("data-drop", "inside");
    act(() => dnd().onDragEnd!(ev("r:r1", "f:f2", 0.5)));
    expect(moveRequest).toHaveBeenCalledWith("r1", "f2", 0);
    expect(setExpanded).toHaveBeenCalledWith("f:f2", true);

    start("f:f1");
    act(() => dnd().onDragEnd!(ev("f:f1", "c:c3", 0.1)));
    expect(moveFolder).toHaveBeenCalledWith("f1", "c3", 0);

    // Folder edges reorder: after "Create" in the same collection.
    start("f:f1");
    act(() => dnd().onDragEnd!(ev("f:f1", "r:r3", 0.9)));
    expect(moveFolder).toHaveBeenLastCalledWith("f1", "c1", 2);
  });

  it("refuses a folder dropped into its own subtree, and drops outside", () => {
    const { moveRequest, moveFolder } = setup();
    start("f:f1");
    act(() => dnd().onDragMove!(ev("f:f1", "f:f2", 0.5)));
    expect(row("Tokens")).not.toHaveAttribute("data-drop");
    act(() => dnd().onDragEnd!(ev("f:f1", "f:f2", 0.5)));
    act(() => dnd().onDragEnd!(ev("r:r1", null)));
    act(() => dnd().onDragEnd!(ev("r:r1", "r:r1")));
    start("r:r1");
    act(() => dnd().onDragCancel!(ev("r:r1", null)));
    expect(moveFolder).not.toHaveBeenCalled();
    expect(moveRequest).not.toHaveBeenCalled();
  });

  it("reorders collections before or after each other only", () => {
    const { reorderCollections, moveRequest } = setup();
    start("c:c1");
    act(() => dnd().onDragMove!(ev("c:c1", "c:c2", 0.9)));
    expect(row("Orders")).toHaveAttribute("data-drop", "after");
    act(() => dnd().onDragEnd!(ev("c:c1", "c:c2", 0.9)));
    expect(reorderCollections).toHaveBeenCalledWith(["c2", "c1", "c3"]);
    act(() => dnd().onDragEnd!(ev("c:c3", "c:c1", 0.1)));
    expect(reorderCollections).toHaveBeenLastCalledWith(["c3", "c1", "c2"]);

    reorderCollections.mockClear();
    act(() => dnd().onDragEnd!(ev("c:c1", "r:r4")));
    act(() => dnd().onDragEnd!(ev("c:c1", "c:c1")));
    expect(reorderCollections).not.toHaveBeenCalled();
    expect(moveRequest).not.toHaveBeenCalled();
  });

  it("ignores drags of something no longer in the tree", () => {
    const { moveRequest } = setup();
    start("r:ghost");
    act(() => dnd().onDragEnd!(ev("r:ghost", "c:c3")));
    expect(moveRequest).not.toHaveBeenCalled();
  });

  it("collision detection: collections only match collections; items skip the dragged folder's subtree", () => {
    setup();
    const rect = (top: number) => ({ top, left: 0, width: 200, height: 20, bottom: top + 20, right: 200 });
    const rects = new Map<string, ReturnType<typeof rect>>([
      ["c:c1", rect(0)],
      ["f:f1", rect(40)],
      ["f:f2", rect(60)],
      ["r:r1", rect(100)],
      ["c:c2", rect(200)],
    ]);
    const containers = [...rects.keys()].map((id) => ({ id, rect: { current: rects.get(id) } }));
    const detect = (active: string, pointer: { x: number; y: number } | null) =>
      dnd().collisionDetection!({
        active: { id: active },
        collisionRect: rect(pointer?.y ?? 500),
        droppableRects: rects,
        droppableContainers: containers,
        pointerCoordinates: pointer,
      } as never).map((c) => c.id);

    expect(detect("c:c1", { x: 10, y: 205 }).every((id) => String(id).startsWith("c:"))).toBe(true);
    expect(detect("r:r3", { x: 10, y: 105 })).toEqual(["r:r1"]);
    expect(detect("r:r3", { x: 10, y: 205 })).toEqual(["c:c2"]);
    expect(detect("r:r3", { x: 10, y: 65 })).toEqual(["f:f2"]);
    expect(detect("r:r3", { x: 10, y: 900 })[0]).toBe("c:c2");

    // While a folder is dragged, it and its subfolders are not drop targets.
    start("f:f1");
    expect(detect("f:f1", { x: 10, y: 65 })).not.toContain("f:f2");
    expect(detect("f:f1", { x: 10, y: 45 })).not.toContain("f:f1");
  });
});
