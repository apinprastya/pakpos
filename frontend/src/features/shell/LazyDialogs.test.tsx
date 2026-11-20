import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dialogLoaders, schedulePreload } from "./dialogChunks";
import { MountWhenOpened } from "./LazyDialogs";

function idleWindow() {
  const queue: Array<() => void> = [];
  const win = {
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    requestIdleCallback: vi.fn((cb: () => void) => queue.push(cb)),
    cancelIdleCallback: vi.fn(),
  };
  const runNext = async () => {
    queue.shift()?.();
    // Let the loader's promise chain settle.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { win: win as unknown as Parameters<typeof schedulePreload>[1], raw: win, queue, runNext };
}

describe("schedulePreload", () => {
  it("loads each chunk in order, one per idle period", async () => {
    const { win, raw, runNext } = idleWindow();
    const calls: string[] = [];
    const a = vi.fn(async () => calls.push("a"));
    const b = vi.fn(async () => calls.push("b"));
    schedulePreload([a, b], win);

    expect(a).not.toHaveBeenCalled();
    await runNext();
    expect(calls).toEqual(["a"]);
    await runNext();
    expect(calls).toEqual(["a", "b"]);
    expect(raw.requestIdleCallback).toHaveBeenCalledTimes(2);
  });

  it("keeps going when a chunk fails to load", async () => {
    const { win, runNext } = idleWindow();
    const b = vi.fn(async () => undefined);
    schedulePreload([() => Promise.reject(new Error("offline")), b], win);
    await runNext();
    await runNext();
    expect(b).toHaveBeenCalled();
  });

  it("stops and cancels the pending callback when cancelled", async () => {
    const { win, raw, runNext } = idleWindow();
    const a = vi.fn(async () => undefined);
    const cancel = schedulePreload([a], win);
    cancel();
    expect(raw.cancelIdleCallback).toHaveBeenCalled();
    await runNext();
    expect(a).not.toHaveBeenCalled();
  });

  it("falls back to a timer without requestIdleCallback", () => {
    const win = { setTimeout: vi.fn(() => 7), clearTimeout: vi.fn() };
    const cancel = schedulePreload([vi.fn(async () => undefined)], win as never);
    expect(win.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1500);
    cancel();
    expect(win.clearTimeout).toHaveBeenCalledWith(7);
  });

  it("preloads the palette first", () => {
    expect(dialogLoaders).toHaveLength(15);
    expect(dialogLoaders[0].toString()).toContain("CommandPalette");
  });
});

describe("MountWhenOpened", () => {
  it("mounts on first open and stays mounted", () => {
    const { rerender } = render(
      <MountWhenOpened open={false}>
        <p>dialog</p>
      </MountWhenOpened>,
    );
    expect(screen.queryByText("dialog")).toBeNull();
    rerender(
      <MountWhenOpened open>
        <p>dialog</p>
      </MountWhenOpened>,
    );
    expect(screen.getByText("dialog")).toBeInTheDocument();
    rerender(
      <MountWhenOpened open={false}>
        <p>dialog</p>
      </MountWhenOpened>,
    );
    expect(screen.getByText("dialog")).toBeInTheDocument();
  });
});
