import type { Request } from "@/lib/model";
import { KeyValueTable } from "./KeyValueTable";
import { setQuery } from "./edits";

interface Props {
  request: Request;
  onChange: (update: (req: Request) => Request) => void;
}

export function ParamsSection({ request, onChange }: Props) {
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="query-params-title">
        <h3 id="query-params-title" className="mb-1 text-xs font-medium text-muted-foreground">
          Query parameters
        </h3>
        <KeyValueTable
          label="Query parameters"
          rows={request.query}
          onChange={(rows) => onChange((r) => setQuery(r, rows))}
        />
      </section>
      {request.pathParams.length > 0 && (
        <section aria-labelledby="path-params-title">
          <h3 id="path-params-title" className="mb-1 text-xs font-medium text-muted-foreground">
            Path parameters
          </h3>
          <KeyValueTable
            label="Path parameters"
            rows={request.pathParams}
            fixedKeys
            keyPlaceholder="Name"
            onChange={(rows) => onChange((r) => ({ ...r, pathParams: rows }))}
          />
        </section>
      )}
      {request.pathParams.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Add <code className="font-mono">:name</code> to the URL path to create a path parameter.
        </p>
      )}
    </div>
  );
}
