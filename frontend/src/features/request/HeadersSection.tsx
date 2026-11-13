import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { bulkToRows, rowsToBulk } from "@/lib/pairs";
import type { Request } from "@/lib/model";
import { cn } from "@/lib/utils";
import { KeyValueTable } from "./KeyValueTable";
import { autoHeaders } from "./autoHeaders";

interface Props {
  request: Request;
  onChange: (update: (req: Request) => Request) => void;
}

let cachedUserAgent = "";

function useUserAgent(): string {
  const [ua, setUa] = useState(cachedUserAgent || "Pakpos");
  useEffect(() => {
    if (cachedUserAgent) return;
    let alive = true;
    api
      .buildInfo()
      .then((info) => {
        cachedUserAgent = `Pakpos/${info.version}`;
        if (alive) setUa(cachedUserAgent);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return ua;
}

export function HeadersSection({ request, onChange }: Props) {
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const userAgent = useUserAgent();
  const auto = autoHeaders(request, userAgent);

  const toggleBulk = () => {
    if (!bulk) setBulkText(rowsToBulk(request.headers));
    setBulk(!bulk);
  };

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="headers-title">
        <div className="mb-1 flex items-center justify-between">
          <h3 id="headers-title" className="text-xs font-medium text-muted-foreground">
            Headers
          </h3>
          <Button variant="ghost" size="xs" onClick={toggleBulk}>
            {bulk ? "Edit as table" : "Edit as text"}
          </Button>
        </div>
        {bulk ? (
          <Textarea
            aria-label="Headers as text"
            className="min-h-40 font-mono text-[12.5px]"
            spellCheck={false}
            placeholder={"Accept: application/json\n//Disabled-Header: value"}
            value={bulkText}
            onChange={(e) => {
              setBulkText(e.target.value);
              const rows = bulkToRows(e.target.value);
              onChange((r) => ({ ...r, headers: rows }));
            }}
          />
        ) : (
          <KeyValueTable
            label="Headers"
            rows={request.headers}
            keyPlaceholder="Header"
            onChange={(rows) => onChange((r) => ({ ...r, headers: rows }))}
          />
        )}
      </section>
      <section aria-labelledby="auto-headers-title">
        <h3 id="auto-headers-title" className="mb-1 text-xs font-medium text-muted-foreground">
          Added when sending
        </h3>
        <ul aria-label="Headers added when sending" className="divide-y divide-border/60 rounded-md border">
          {auto.map((h) => (
            <li
              key={h.name}
              className={cn(
                "grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 px-3 py-1 font-mono text-[12px]",
                h.overridden && "text-muted-foreground line-through",
              )}
              title={h.overridden ? "Replaced by your header" : undefined}
            >
              <span className="truncate">{h.name}</span>
              <span className="selectable truncate text-muted-foreground">{h.value}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
