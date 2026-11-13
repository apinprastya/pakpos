import { formatJSON, formatXML } from "./beautify";

describe("beautify", () => {
  it("formats JSON", () => {
    expect(formatJSON('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(formatJSON("{bad")).toBeNull();
  });

  it("formats XML", () => {
    const xml = '<?xml version="1.0"?><root><!-- c --><a x="1">hi</a><b/><c><d>1</d></c><![CDATA[x]]></root>';
    expect(formatXML(xml)).toBe(
      [
        '<?xml version="1.0"?>',
        "<root>",
        "  <!-- c -->",
        '  <a x="1">hi</a>',
        "  <b/>",
        "  <c>",
        "    <d>1</d>",
        "  </c>",
        "  <![CDATA[x]]>",
        "</root>",
      ].join("\n"),
    );
  });

  it("keeps loose text and rejects unbalanced XML", () => {
    expect(formatXML("<a>x<b/>y</a>")).toBe("<a>\n  x\n  <b/>\n  y\n</a>");
    expect(formatXML("<a>")).toBeNull();
    expect(formatXML("</a>")).toBeNull();
    expect(formatXML("")).toBeNull();
  });
});
