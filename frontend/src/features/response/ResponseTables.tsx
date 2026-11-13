import type { Cookie, KeyValue } from "@/lib/model";

export function HeadersTable({ headers }: { headers: KeyValue[] }) {
  if (headers.length === 0) return <Empty>The response has no headers.</Empty>;
  return (
    <table aria-label="Response headers" className="w-full text-left text-[12.5px]">
      <thead className="sr-only">
        <tr>
          <th>Name</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {headers.map((h, i) => (
          <tr key={i} className="border-b border-border/60 align-top">
            <th scope="row" className="w-2/5 px-3 py-1 font-mono font-medium">
              {h.key}
            </th>
            <td className="selectable px-3 py-1 font-mono break-all text-muted-foreground">{h.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CookiesTable({ cookies }: { cookies: Cookie[] }) {
  if (cookies.length === 0) return <Empty>The response set no cookies.</Empty>;
  return (
    <table aria-label="Response cookies" className="w-full text-left text-[12.5px]">
      <thead className="text-xs text-muted-foreground">
        <tr className="border-b">
          <th className="px-3 py-1 font-normal">Name</th>
          <th className="px-3 py-1 font-normal">Value</th>
          <th className="px-3 py-1 font-normal">Domain</th>
          <th className="px-3 py-1 font-normal">Path</th>
          <th className="px-3 py-1 font-normal">Expires</th>
          <th className="px-3 py-1 font-normal">Flags</th>
        </tr>
      </thead>
      <tbody>
        {cookies.map((c, i) => (
          <tr key={i} className="border-b border-border/60 align-top">
            <td className="px-3 py-1 font-mono font-medium">{c.name}</td>
            <td className="selectable max-w-64 px-3 py-1 font-mono break-all text-muted-foreground">
              {c.value}
            </td>
            <td className="px-3 py-1 font-mono">{c.domain || "—"}</td>
            <td className="px-3 py-1 font-mono">{c.path || "—"}</td>
            <td className="px-3 py-1">{c.expires ? new Date(c.expires).toLocaleString() : "Session"}</td>
            <td className="px-3 py-1 text-muted-foreground">
              {[c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite && `SameSite=${c.sameSite}`]
                .filter(Boolean)
                .join(", ") || "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>;
}
