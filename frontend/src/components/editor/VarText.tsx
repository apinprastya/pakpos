import { memo } from "react";
import { splitVars } from "@/lib/varTokens";
import type { VarScope } from "@/lib/variables";
import { varClass } from "./variables";

/**
 * Text with its `{{variables}}` marked like in the editor, without an
 * editor: what table cells show until they're focused.
 */
export const VarText = memo(function VarText({ text, scope }: { text: string; scope: VarScope }) {
  return (
    <>
      {splitVars(text).map((p, i) =>
        p.token ? (
          <span key={i} className={varClass(p.token.name, scope)}>
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
});
