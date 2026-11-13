import { act, render } from "@testing-library/react";
import type { DndContextProps } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CollectionNode } from "@/lib/model";
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

const cols: CollectionNode[] = [
  {
    id: "c1",
    name: "Users",
    seq: 1,
    requests: [
      { id: "r1", name: "List", method: "GET", url: "", seq: 1 },
      { id: "r2", name: "Create", method: "POST", url: "", seq: 2 },
    ],
  },
  { id: "c2", name: "Orders", seq: 2, requests: [{ id: "r3", name: "Get", method: "GET", url: "", seq: 1 }] },
  { id: "c3", name: "Empty", seq: 3, requests: [] },
];

const dnd = () => captured.props!;
type Ev = Parameters<NonNullable<DndContextProps["onDragEnd"]>>[0];
const ev = (active: string, over: string | null) =>
  ({ active: { id: active }, over: over ? { id: over } : null }) as Ev;

function setup() {
  useWorkspaceStore.setState({ collections: cols, status: "ready" });
  const store = useWorkspaceStore.getState();
  const moveRequest = vi.spyOn(store, "moveRequest").mockResolvedValue();
  const reorderCollections = vi.spyOn(store, "reorderCollections").mockResolvedValue();
  render(
    <TooltipProvider>
      <CollectionTree
        collections={cols}
        filtering={false}
        isExpanded={() => true}
        setExpanded={() => {}}
        confirmDelete={() => {}}
      />
    </TooltipProvider>,
  );
  return { moveRequest, reorderCollections };
}

describe("collection tree drag and drop", () => {
  it("moves a request into another collection, previewing while dragging", () => {
    const { moveRequest } = setup();
    act(() => dnd().onDragStart!(ev("r:r1", null)));
    act(() => dnd().onDragOver!(ev("r:r1", "r:r3")));
    // Hovering within the same collection doesn't rebuild the preview.
    act(() => dnd().onDragOver!(ev("r:r1", "r:r3")));
    act(() => dnd().onDragOver!(ev("r:r1", null)));
    act(() => dnd().onDragEnd!(ev("r:r1", "r:r1")));
    expect(moveRequest).toHaveBeenCalledWith("r1", "c2", 0);
  });

  it("drops onto a collection header at its end, and reorders within a collection", () => {
    const { moveRequest } = setup();
    act(() => dnd().onDragStart!(ev("r:r1", null)));
    act(() => dnd().onDragEnd!(ev("r:r1", "c:c3")));
    expect(moveRequest).toHaveBeenLastCalledWith("r1", "c3", 0);

    act(() => dnd().onDragStart!(ev("r:r2", null)));
    act(() => dnd().onDragEnd!(ev("r:r2", "r:r1")));
    expect(moveRequest).toHaveBeenLastCalledWith("r2", "c1", 0);
  });

  it("reorders collections and ignores drops outside or onto requests", () => {
    const { moveRequest, reorderCollections } = setup();
    act(() => dnd().onDragStart!(ev("c:c1", null)));
    act(() => dnd().onDragOver!(ev("c:c1", "c:c2")));
    act(() => dnd().onDragEnd!(ev("c:c1", "c:c2")));
    expect(reorderCollections).toHaveBeenCalledWith(["c2", "c1", "c3"]);

    reorderCollections.mockClear();
    act(() => dnd().onDragEnd!(ev("c:c1", "r:r3")));
    act(() => dnd().onDragEnd!(ev("c:c1", "c:c1")));
    act(() => dnd().onDragEnd!(ev("r:r1", null)));
    act(() => dnd().onDragCancel!(ev("r:r1", null)));
    expect(reorderCollections).not.toHaveBeenCalled();
    expect(moveRequest).not.toHaveBeenCalled();
  });

  it("collision detection: collections only match collections; requests prefer the request under the pointer", () => {
    setup();
    const rect = (top: number) => ({ top, left: 0, width: 200, height: 20, bottom: top + 20, right: 200 });
    const rects = new Map<string, ReturnType<typeof rect>>([
      ["c:c1", rect(0)],
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
    expect(detect("r:r2", { x: 10, y: 105 })).toEqual(["r:r1"]);
    expect(detect("r:r2", { x: 10, y: 205 })).toEqual(["c:c2"]);
    expect(detect("r:r2", { x: 10, y: 900 })).toEqual(["r:r1"]);
  });
});
