import { restoreTimestampState, timestampInitialState, timestampWithInput } from "./state";

describe("timestamp tool state", () => {
  it.each([
    [
      { input: "1700000000", unit: "ms", zone: "Asia/Jakarta" },
      { input: "1700000000", unit: "ms", zone: "Asia/Jakarta" },
    ],
    [{ input: 5, unit: "days", zone: 7 }, timestampInitialState()],
    [{ input: "x".repeat(1001) }, timestampInitialState()],
    [null, timestampInitialState()],
    ["1700000000", timestampInitialState()],
  ])("restores %j", (raw, want) => {
    expect(restoreTimestampState(raw)).toEqual(want);
  });

  it("takes new input and keeps the unit and zone", () => {
    expect(timestampInitialState("1")).toEqual({ input: "1", unit: "auto", zone: "" });
    const s = { input: "a", unit: "us" as const, zone: "UTC" };
    expect(timestampWithInput(s, "2")).toEqual({ ...s, input: "2" });
  });
});
