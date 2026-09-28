// Prints the first differing JSON paths between the committed (HEAD) and working-tree versions of the files
// given, for CI checks on generated JSON (single-line files make a textual diff unreadable).
//   node json-diff.mjs [--ignore-key <name> ...] [--fail] <file> ...
// --ignore-key skips every property with that name (e.g. encoder-dependent `variants`); --fail exits 1 when
// anything differs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const ignored = new Set(args.flatMap((a, i) => (args[i - 1] === '--ignore-key' ? [a] : [])));
const fail = args.includes('--fail');
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--ignore-key');
let differing = 0;

function* diff(a, b, at) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!ignored.has(k)) yield* diff(a[k], b[k], `${at}.${k}`);
    return;
  }
  const show = (v) => (v === undefined ? '(absent)' : JSON.stringify(v).slice(0, 120));
  yield `${at}: ${show(a)} -> ${show(b)}`;
}

for (const file of files) {
  let before;
  try {
    before = JSON.parse(execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  } catch {
    console.log(`${file}: new file`);
    differing++;
    continue;
  }
  const lines = [...diff(before, JSON.parse(fs.readFileSync(file, 'utf8')), '')];
  if (lines.length === 0) continue;
  differing++;
  console.log(`${file}: ${lines.length} difference(s)`);
  for (const line of lines.slice(0, 8)) console.log(`  ${line}`);
}
console.log(`${differing} of ${files.length} file(s) differ${ignored.size ? ` (ignoring ${[...ignored].join(', ')})` : ''}`);
if (fail && differing > 0) process.exit(1);
