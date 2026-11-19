import { Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { toolDef } from "./registry";

/** A tool's icon from the registry (a wrench for a tool this build doesn't know). */
export function ToolIcon({ id, className }: { id: string; className?: string }) {
  const Icon = toolDef(id)?.icon ?? Wrench;
  return <Icon aria-hidden className={cn("shrink-0 text-muted-foreground", className)} />;
}
