import type { HistorySummary } from "@/lib/model";
import { dayLabel, groupByDay, statusLabel, timeLabel } from "./historyFormat";

const now = new Date(2026, 10, 14, 15, 0, 0);

describe("dayLabel", () => {
  it("names today and yesterday, and formats older dates", () => {
    expect(dayLabel(new Date(2026, 10, 14, 1), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 13, 23), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 10), now)).not.toMatch(/2026/);
    expect(dayLabel(new Date(2025, 0, 2), now)).toMatch(/2025/);
  });
});

describe("timeLabel", () => {
  it("is relative today and a clock time before", () => {
    expect(timeLabel(new Date(2026, 10, 14, 14, 59, 30), now)).toBe("just now");
    expect(timeLabel(new Date(2026, 10, 14, 14, 55), now)).toBe("5m ago");
    expect(timeLabel(new Date(2026, 10, 14, 12, 0), now)).toBe("3h ago");
    expect(timeLabel(new Date(2026, 10, 13, 9, 5), now)).toMatch(/9|09/);
  });
});

describe("groupByDay", () => {
  it("keeps order and starts a new group per day", () => {
    const item = (id: number, d: Date) => ({ id, createdAt: d.toISOString() }) as HistorySummary;
    const groups = groupByDay(
      [
        item(3, new Date(2026, 10, 14, 14)),
        item(2, new Date(2026, 10, 14, 9)),
        item(1, new Date(2026, 10, 13, 9)),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", [3, 2]],
      ["Yesterday", [1]],
    ]);
  });
});

describe("statusLabel", () => {
  it("shows the code, Canceled or Failed", () => {
    expect(statusLabel({ status: 404, errorKind: "" })).toBe("404");
    expect(statusLabel({ status: 0, errorKind: "canceled" })).toBe("Canceled");
    expect(statusLabel({ status: 0, errorKind: "dns" })).toBe("Failed");
  });
});

describe("displayUrl", () => {
  it("drops the scheme only", async () => {
    const { displayUrl } = await import("./historyFormat");
    expect(displayUrl("https://api.dev/users?x=1")).toBe("api.dev/users?x=1");
    expect(displayUrl("{{base}}/users")).toBe("{{base}}/users");
  });
});
