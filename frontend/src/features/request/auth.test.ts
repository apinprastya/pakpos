import { isLiteralSecret, isReferenceOnly } from "./auth";

describe("isReferenceOnly", () => {
  it.each([
    ["{{token}}", true],
    ["{{ token }}", true],
    ["{{a}}{{b}}", true],
    ["{{", true],
    ["{{tok", true],
    ["{{tok}", true],
    ["{{a}}{{b", true],
    ["", false],
    ["{", false],
    ["abc", false],
    [" {{token}}", false],
    ["{{token}}x", false],
    ["Bearer {{token}}", false],
    ["{{}}", false],
    ["{{a}}}", false],
  ])("%j → %s", (value, want) => {
    expect(isReferenceOnly(value)).toBe(want);
  });

  it("is never true for a literal secret", () => {
    for (const v of ["abc", "{{tok", "{{a}}"]) expect(isReferenceOnly(v) && isLiteralSecret(v)).toBe(false);
  });
});
