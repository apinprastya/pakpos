import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { TEMPLATE_REFS } from "@/lib/webhookModel";

/**
 * Completes reply templates after "{{": the incoming request's fields and the
 * dynamic variables. Workspace variables are never offered (they don't
 * resolve in replies).
 */
export const templateCompletions: CompletionSource = (ctx: CompletionContext): CompletionResult | null => {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /\{\{\s*([\w$.-]*)$/.exec(before);
  if (!m) return null;
  return {
    from: ctx.pos - m[1].length,
    options: TEMPLATE_REFS.map((r) => ({
      label: r.label,
      detail: r.detail,
      type: "variable",
      // A finished reference closes the braces; a prefix (".query.") waits for the name.
      apply: r.label.endsWith(".") ? r.label : `${r.label}}}`,
    })),
    validFor: /^[\w$.-]*$/,
  };
};
