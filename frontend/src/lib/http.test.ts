import { HTTP_METHODS, isHttpMethod, methodShortLabel, methodTextClass } from "./http";

describe("http helpers", () => {
  it("lists the seven supported methods", () => {
    expect(HTTP_METHODS).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  });

  it.each([
    ["GET", true],
    ["patch", false],
    ["TRACE", false],
  ])("isHttpMethod(%s) = %s", (input, expected) => {
    expect(isHttpMethod(input)).toBe(expected);
  });

  it.each([
    ["GET", "text-method-get"],
    ["post", "text-method-post"],
    ["PUT", "text-method-put"],
    ["PATCH", "text-method-patch"],
    ["DELETE", "text-method-delete"],
    ["HEAD", "text-method-other"],
    ["OPTIONS", "text-method-other"],
    ["PROPFIND", "text-method-other"],
  ])("methodTextClass(%s) = %s", (method, cls) => {
    expect(methodTextClass(method)).toBe(cls);
  });

  it.each([
    ["delete", "DEL"],
    ["OPTIONS", "OPT"],
    ["get", "GET"],
  ])("methodShortLabel(%s) = %s", (method, label) => {
    expect(methodShortLabel(method)).toBe(label);
  });
});
