// Prints the first differing JSON paths between the committed (HEAD) and working-tree versions of the files
// given, for CI checks on generated JSON (single-line files make a textual diff unreadable).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function* diff(a, b, at) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) yield* diff(a[k], b[k], `${at}.${k}`);
    return;
  }
  const show = (v) => (v === undefined ? '(absent)' : JSON.stringify(v).slice(0, 120));
  yield `${at}: ${show(a)} -> ${show(b)}`;
}

for (const file of process.argv.slice(2)) {
  let before;
  try {
    before = JSON.parse(execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  } catch {
    console.log(`${file}: new file`);
    continue;
  }
  const lines = [...diff(before, JSON.parse(fs.readFileSync(file, 'utf8')), '')];
  console.log(`${file}: ${lines.length} difference(s)`);
  for (const line of lines.slice(0, 8)) console.log(`  ${line}`);
}
