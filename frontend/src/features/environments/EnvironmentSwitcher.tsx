import { Layers } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useEnvironmentsStore } from "@/stores/environments";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";

const NONE = "__none__";
const GLOBALS = "__globals__";
const MANAGE = "__manage__";

/** Picks the environment requests are sent with; also opens the globals and the manage view. */
export function EnvironmentSwitcher({ className }: { className?: string }) {
  const hasWorkspace = useWorkspaceStore((s) => s.workspace !== null);
  const environments = useEnvironmentsStore((s) => s.environments);
  const selectedId = useEnvironmentsStore((s) => s.selectedId);
  const status = useEnvironmentsStore((s) => s.status);
  if (!hasWorkspace) return null;

  const value = environments.some((e) => e.id === selectedId) ? selectedId : NONE;
  const onValueChange = (v: string) => {
    const store = useEnvironmentsStore.getState();
    if (v === MANAGE) useLayoutStore.getState().setSidebarView("environments");
    else if (v === GLOBALS) store.openGlobals();
    else void store.select(v === NONE ? "" : v);
  };

  return (
    <Select value={value} onValueChange={onValueChange} disabled={status === "loading"}>
      <SelectTrigger
        size="sm"
        aria-label="Environment"
        title="Environment used to send requests"
        className={cn(
          "h-7! w-44 justify-start gap-1.5 border-transparent bg-transparent! px-2 text-xs shadow-none hover:bg-sidebar-accent *:data-[slot=select-value]:flex-1 *:data-[slot=select-value]:truncate",
          value === NONE && "text-muted-foreground",
          className,
        )}
      >
        <Layers aria-hidden className="size-3.5 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" position="popper" className="min-w-52">
        <SelectGroup>
          <SelectItem value={NONE}>No environment</SelectItem>
          {environments.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.name}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectItem value={GLOBALS}>Edit globals</SelectItem>
          <SelectItem value={MANAGE}>Manage environments…</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
