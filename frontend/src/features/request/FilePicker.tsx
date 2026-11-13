import { FileUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { basename } from "@/lib/path";
import { pickFile } from "./actions";

interface Props {
  path: string;
  onChange: (path: string) => void;
  /** Accessible context, e.g. "binary body" or "form field 2". */
  label: string;
}

export function FilePicker({ path, onChange, label }: Props) {
  const choose = async () => {
    const p = await pickFile();
    if (p) onChange(p);
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Button variant="outline" size="xs" onClick={choose} aria-label={`Choose file for ${label}`}>
        <FileUp /> {path ? "Change" : "Choose file"}
      </Button>
      {path && (
        <>
          <span className="selectable min-w-0 truncate font-mono text-xs" title={path}>
            {basename(path)}
          </span>
          <button
            type="button"
            aria-label={`Remove file for ${label}`}
            onClick={() => onChange("")}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
