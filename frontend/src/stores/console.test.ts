import { makeConsoleEntry, makeResponse, makeResult, makeScriptSource } from "@/test/fixtures";
import { MAX_CONSOLE_ENTRIES, statusText, useConsoleStore } from "./console";

const s = () => useConsoleStore.getState();
const texts = (sendId: string) =>
  s()
    .groups.find((g) => g.sendId === sendId)
    ?.lines.map((l) => l.text);

describe("console store", () => {
  it("groups lines per send and replaces the live lines with the result's, without duplicates", () => {
    s().begin("a", { method: "POST", name: "Login" });
    expect(s().groups[0]).toMatchObject({
      sendId: "a",
      method: "POST",
      name: "Login",
      status: "",
      done: false,
    });
    s().append("a", [makeConsoleEntry("one")]);
    s().append("a", []);
    s().append("a", [makeConsoleEntry("two")]);
    expect(texts("a")).toEqual(["one", "two"]);
    expect(s().unread).toBe(2);

    const result = makeResult({
      response: makeResponse({ statusCode: 201, statusText: "Created" }),
      console: [makeConsoleEntry("one"), makeConsoleEntry("two"), makeConsoleEntry("three")],
    });
    s().finish("a", result);
    expect(texts("a")).toEqual(["one", "two", "three"]);
    expect(s().groups[0]).toMatchObject({ status: "201 Created", done: true });
    // Only the line the events hadn't brought counts as new.
    expect(s().unread).toBe(3);

    // A late event of a finished send is ignored, as are unknown sends.
    s().append("a", [makeConsoleEntry("late")]);
    s().append("zzz", [makeConsoleEntry("x")]);
    s().finish("zzz", result);
    expect(texts("a")).toEqual(["one", "two", "three"]);
  });

  it("drops the header of a send that logged nothing, and adds a pre-request script error", () => {
    s().begin("quiet", { method: "GET", name: "Q" });
    s().finish("quiet", makeResult());
    expect(s().groups).toEqual([]);

    s().begin("err", { method: "GET", name: "E" });
    s().finish(
      "err",
      makeResult({
        error: { kind: "script", message: "Error in the pre-request script at line 1:1: boom" },
        scriptError: { source: makeScriptSource(), line: 1, column: 1 },
      }),
    );
    expect(s().groups[0].lines).toMatchObject([{ level: "error", text: expect.stringContaining("boom") }]);
    expect(s().groups[0].status).toBe("Error");
  });

  it("re-begins a send id afresh", () => {
    s().begin("a", { method: "GET", name: "A" });
    s().append("a", [makeConsoleEntry("x")]);
    s().begin("a", { method: "GET", name: "A" });
    expect(s().groups).toHaveLength(1);
    expect(texts("a")).toEqual([]);
  });

  it("caps the lines, dropping the oldest first", () => {
    s().begin("old", { method: "GET", name: "Old" });
    s().finish(
      "old",
      makeResult({ console: Array.from({ length: 10 }, (_, i) => makeConsoleEntry(`old ${i}`)) }),
    );
    s().begin("new", { method: "GET", name: "New" });
    s().append(
      "new",
      Array.from({ length: MAX_CONSOLE_ENTRIES - 5 }, (_, i) => makeConsoleEntry(`new ${i}`)),
    );
    expect(texts("old")).toEqual(["old 5", "old 6", "old 7", "old 8", "old 9"]);
    s().append(
      "new",
      Array.from({ length: 10 }, () => makeConsoleEntry("more")),
    );
    // The old group emptied out and went away; the new one is still running.
    expect(s().groups.map((g) => g.sendId)).toEqual(["new"]);
    expect(s().groups[0].lines).toHaveLength(MAX_CONSOLE_ENTRIES);
  });

  it("counts unread lines only while closed, and clears", () => {
    s().setOpen(true);
    s().begin("a", { method: "GET", name: "A" });
    s().append("a", [makeConsoleEntry("x")]);
    s().finish("a", makeResult({ console: [makeConsoleEntry("x"), makeConsoleEntry("y")] }));
    expect(s().unread).toBe(0);
    s().toggle();
    expect(s().open).toBe(false);
    s().begin("b", { method: "GET", name: "B" });
    s().append("b", [makeConsoleEntry("z")]);
    expect(s().unread).toBe(1);
    s().toggle();
    expect(s()).toMatchObject({ open: true, unread: 0 });
    s().clear();
    expect(s().groups).toEqual([]);
  });

  it("describes how a send ended", () => {
    expect(statusText(makeResult({ skipped: true }))).toBe("Skipped");
    expect(statusText(makeResult({ error: { kind: "canceled", message: "" } }))).toBe("Cancelled");
    expect(statusText(makeResult({ error: { kind: "network", message: "" } }))).toBe("Error");
    expect(statusText(makeResult({ response: makeResponse({ statusCode: 204, statusText: "" }) }))).toBe(
      "204",
    );
    expect(statusText(makeResult())).toBe("");
  });
});
