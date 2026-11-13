import { useLayoutStore } from "./layout";

describe("layout store", () => {
  beforeEach(() => useLayoutStore.setState({ sidebarView: "collections", splitOrientation: "vertical" }));

  it("switches sidebar view", () => {
    useLayoutStore.getState().setSidebarView("history");
    expect(useLayoutStore.getState().sidebarView).toBe("history");
  });

  it("toggles split orientation both ways", () => {
    useLayoutStore.getState().toggleSplitOrientation();
    expect(useLayoutStore.getState().splitOrientation).toBe("horizontal");
    useLayoutStore.getState().toggleSplitOrientation();
    expect(useLayoutStore.getState().splitOrientation).toBe("vertical");
  });
});
