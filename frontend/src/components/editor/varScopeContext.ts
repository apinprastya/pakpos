import { createContext, useContext } from "react";
import type { VarScope } from "@/lib/variables";

/**
 * The variables visible in the current tab, shared by every editor in it so
 * there's one fetch per tab. Undefined outside a provider: editors there
 * (e.g. the response viewer) don't mark variables at all.
 */
export const VarScopeContext = createContext<VarScope | undefined>(undefined);

export function useVarScope(): VarScope | undefined {
  return useContext(VarScopeContext);
}
