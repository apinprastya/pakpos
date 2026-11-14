import { caretFromPoint } from "./caret";

describe("caretFromPoint", () => {
  const doc = document as unknown as {
    caretPositionFromPoint?: () => unknown;
    caretRangeFromPoint?: () => unknown;
  };
  afterEach(() => {
    delete doc.caretPositionFromPoint;
    delete doc.caretRangeFromPoint;
  });

  function el() {
    const div = document.createElement("div");
    div.innerHTML = "<span>ab<span>{{c}}</span>de</span>";
    document.body.appendChild(div);
    return div;
  }

  it("counts text before the clicked node", () => {
    const div = el();
    const inner = div.querySelector("span span")!.firstChild!;
    doc.caretPositionFromPoint = () => ({ offsetNode: inner, offset: 3 });
    expect(caretFromPoint(div, 0, 0)).toBe(5);
  });

  it("gives up when the browser can't tell or the point is elsewhere", () => {
    const div = el();
    expect(caretFromPoint(div, 0, 0)).toBeNull();
    doc.caretPositionFromPoint = () => null;
    expect(caretFromPoint(div, 0, 0)).toBeNull();
    doc.caretPositionFromPoint = () => ({ offsetNode: div, offset: 0 });
    expect(caretFromPoint(div, 0, 0)).toBeNull();
    doc.caretPositionFromPoint = () => ({ offsetNode: document.createTextNode("x"), offset: 0 });
    expect(caretFromPoint(div, 0, 0)).toBeNull();
    delete doc.caretPositionFromPoint;
    doc.caretRangeFromPoint = () => null;
    expect(caretFromPoint(div, 0, 0)).toBeNull();
  });
});
