/**
 * `$name` substitution for translated message text, as upstream's `VGETTEXT`
 * does (`utils::interpolate_variables_into_string` over a small string map).
 * The order is always translate first, then substitute, so a translator can
 * move a placeholder anywhere in the sentence. `$name|` ends a name where the
 * next character would otherwise continue it; `$$` is a literal `$`. An
 * unknown name is left as written.
 */
export function formatMessage(text: string, vars: Readonly<Record<string, string | number>>): string {
  return text.replace(/\$\$|\$([A-Za-z_][A-Za-z0-9_]*)\|?/g, (whole, name: string | undefined) => {
    if (whole === '$$') return '$';
    const v = name === undefined ? undefined : vars[name];
    return v === undefined ? whole : String(v);
  });
}
