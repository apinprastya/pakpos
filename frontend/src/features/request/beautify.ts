/** Pretty-printers for raw bodies and responses. Return null when the input can't be parsed. */

export function formatJSON(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/**
 * Indents XML one element per line. Text-only elements stay on one line.
 * It is a tokenizer, not a validator: unbalanced input returns null.
 */
export function formatXML(text: string): string | null {
  const tokens = text.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g);
  if (!tokens) return null;
  const out: string[] = [];
  let depth = 0;
  const pad = () => "  ".repeat(depth);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("<")) {
      const t = tok.trim();
      if (t) out.push(pad() + t);
      continue;
    }
    if (tok.startsWith("</")) {
      depth -= 1;
      if (depth < 0) return null;
      out.push(pad() + tok);
      continue;
    }
    const selfContained = tok.startsWith("<?") || tok.startsWith("<!") || tok.endsWith("/>");
    if (selfContained) {
      out.push(pad() + tok);
      continue;
    }
    // <a>text</a> on one line.
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (next && !next.startsWith("<") && after?.startsWith("</")) {
      out.push(pad() + tok + next.trim() + after);
      i += 2;
      continue;
    }
    out.push(pad() + tok);
    depth += 1;
  }
  return depth === 0 ? out.join("\n") : null;
}
