export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

const METHOD_TEXT_CLASS: Record<HttpMethod, string> = {
  GET: "text-method-get",
  POST: "text-method-post",
  PUT: "text-method-put",
  PATCH: "text-method-patch",
  DELETE: "text-method-delete",
  HEAD: "text-method-other",
  OPTIONS: "text-method-other",
};

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/** Tailwind text colour class for an HTTP method; unknown methods get the neutral colour. */
export function methodTextClass(method: string): string {
  const upper = method.toUpperCase();
  return isHttpMethod(upper) ? METHOD_TEXT_CLASS[upper] : "text-method-other";
}

/** Short label used in narrow places such as tabs and tree rows. */
export function methodShortLabel(method: string): string {
  const upper = method.toUpperCase();
  if (upper === "DELETE") return "DEL";
  if (upper === "OPTIONS") return "OPT";
  return upper;
}
