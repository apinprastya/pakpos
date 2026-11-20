import { idsInitialState, idsWithInput, restoreIdsState, serializeIdsState } from "./state";

describe("ID generator state", () => {
  it.each([
    [
      {
        kind: "ulid",
        count: "20",
        upper: true,
        hyphens: false,
        inspect: "x",
        generated: { kind: "ulid", ids: ["A"] },
      },
      { kind: "ulid", count: "20", upper: true, hyphens: false, inspect: "x", generated: null },
    ],
    [{ kind: "uuid1", count: 3, upper: "yes", hyphens: 0, inspect: null }, idsInitialState()],
    [null, idsInitialState()],
    ["uuid4", idsInitialState()],
  ])("restores %j", (raw, want) => {
    expect(restoreIdsState(raw)).toEqual(want);
  });

  it("starts with one UUID v4 and puts entry-point input in the Inspect field", () => {
    expect(idsInitialState()).toEqual({
      kind: "uuid4",
      count: "1",
      upper: false,
      hyphens: true,
      inspect: "",
      generated: null,
    });
    expect(idsWithInput({ ...idsInitialState(), kind: "ulid" }, "01ARYZ6S41F66H2K2F8E0A4GGT")).toMatchObject({
      kind: "ulid",
      inspect: "01ARYZ6S41F66H2K2F8E0A4GGT",
    });
  });

  it("persists the options and the Inspect field, not the generated IDs", () => {
    const s = { ...idsInitialState("abc"), generated: { kind: "uuid4" as const, ids: ["x"] } };
    expect(serializeIdsState(s)).toEqual({
      kind: "uuid4",
      count: "1",
      upper: false,
      hyphens: true,
      inspect: "abc",
    });
  });
});
