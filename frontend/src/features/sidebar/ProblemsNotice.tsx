import { TriangleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { plural } from "@/lib/errors";
import type { Problem } from "@/lib/model";

/** Files in the workspace that couldn't be loaded, e.g. hand-edited YAML with a typo. */
export function ProblemsNotice({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger className="mx-2 mb-2 flex shrink-0 items-center gap-2 rounded-md border border-status-client/40 px-2 py-1.5 text-left text-xs text-status-client hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <TriangleAlert className="size-3.5 shrink-0" />
        <span>{plural(problems.length, "file")} couldn&apos;t be loaded</span>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-96">
        <p className="mb-2 text-sm font-medium">These files were skipped</p>
        <ul className="flex max-h-64 flex-col gap-2 overflow-auto">
          {problems.map((p) => (
            <li key={p.path} className="text-xs">
              <p className="font-mono break-all">{p.path}</p>
              <p className="text-muted-foreground">{p.message}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Fix or remove them in the workspace folder. This list updates when the files change.
        </p>
      </PopoverContent>
    </Popover>
  );
}
