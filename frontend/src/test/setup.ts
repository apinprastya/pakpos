import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

// jsdom lacks these browser APIs used by Radix / resizable panels.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.setPointerCapture ??= () => {};

// Radix menus check `event instanceof PointerEvent`; jsdom doesn't ship it.
if (!globalThis.PointerEvent) {
  class PointerEventStub extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  globalThis.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
}

// react-resizable-panels hit-tests separators by geometry; in jsdom every rect is 0x0,
// so every pointer event is captured as a resize. Use plain containers in unit tests.
vi.mock("@/components/ui/resizable", async () => {
  const React = await import("react");
  const passthrough =
    (slot: string) =>
    ({ children, className }: { children?: React.ReactNode; className?: string }) =>
      React.createElement("div", { "data-slot": slot, className }, children);
  return {
    ResizablePanelGroup: passthrough("resizable-panel-group"),
    ResizablePanel: passthrough("resizable-panel"),
    ResizableHandle: passthrough("resizable-handle"),
  };
});
