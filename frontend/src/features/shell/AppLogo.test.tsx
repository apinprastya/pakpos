import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppLogo } from "./AppLogo";

describe("AppLogo", () => {
  it("draws the perforated stamp from the app icon, hidden from assistive tech", () => {
    const { container } = render(<AppLogo className="mb-2" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("size-8", "mb-2");
    // Ten holes per edge plus the four corners, as in build/appicon.svg.
    expect(svg.querySelectorAll("mask circle")).toHaveLength(44);
    expect(svg.querySelectorAll(".fill-logo-stamp")).toHaveLength(3);
  });

  it("gives each instance its own mask and clip ids", () => {
    const { container } = render(
      <>
        <AppLogo />
        <AppLogo />
      </>,
    );
    const ids = [...container.querySelectorAll("mask, clipPath")].map((el) => el.id);
    expect(new Set(ids).size).toBe(4);
    const stamp = container.querySelector("svg > rect")!;
    expect(stamp.getAttribute("mask")).toBe(`url(#${ids[0]})`);
  });
});
