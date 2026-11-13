import type { KeyValue, Request } from "@/lib/model";
import { mergeQuery, syncPathParams, withQuery } from "@/lib/urlx";

/** Sets the URL and re-derives the query and path-param tables from it. */
export function setUrl(req: Request, url: string): Request {
  return {
    ...req,
    url,
    query: mergeQuery(url, req.query),
    pathParams: syncPathParams(url, req.pathParams),
  };
}

/** Sets the query table and rewrites the URL's query string from it. */
export function setQuery(req: Request, query: KeyValue[]): Request {
  return { ...req, query, url: withQuery(req.url, query) };
}
