/**
 * A scenario file's own `[scenario] id=` (or `[test]`'s), read from its text without preprocessing it: the
 * first `id` assigned directly inside the top-level tag, skipping `#define`...`#enddef` bodies (Legend of
 * Wesmere 21 opens with a macro naming `id=Kalenz`) and the tags nested in it. WML's multi-key assignment
 * counts (`id,map_file,name=00_Graduation,...`, as The Deceiver's Gambit writes it). Null for a file with
 * no such tag (a campaign's helper files under `scenarios/`).
 */
export function scenarioIdOf(text) {
  let inDefine = false;
  let depth = -1;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // `#enddef` may end a line of the body (`{ON_DIFFICULTY 17 15 13} #enddef`), or the `#define` line itself.
    if (inDefine) {
      if (/#enddef\b/.test(line)) inDefine = false;
      continue;
    }
    if (line.startsWith('#define')) {
      inDefine = !/#enddef\b/.test(line);
      continue;
    }
    if (line.startsWith('#') || line === '') continue;
    const tag = /^\[(\/)?\+?(\w+)\]/.exec(line);
    if (tag) {
      if (depth < 0) {
        if (!tag[1] && (tag[2] === 'scenario' || tag[2] === 'test')) depth = 1;
      } else {
        depth += tag[1] ? -1 : 1;
        if (depth === 0) return null;
      }
      continue;
    }
    if (depth !== 1) continue;
    const assign = /^([\w,]+)\s*=\s*(.*)$/.exec(line);
    if (!assign) continue;
    const index = assign[1].split(',').indexOf('id');
    if (index < 0) continue;
    const value = splitValues(assign[2])[index];
    return value === undefined ? null : value.trim().replace(/^"(.*)"$/, '$1');
  }
  return null;
}

/** A multi-key assignment's values: comma-separated, commas inside quotes kept. */
function splitValues(text) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}
