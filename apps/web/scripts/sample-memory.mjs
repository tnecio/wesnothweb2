#!/usr/bin/env node
/**
 * Writes, every 2 s until killed, the resident memory of every process whose command matches a pattern (by default
 * Safari's content processes, `com.apple.WebKit.WebContent`, which on macOS include the iOS simulator's):
 * `<unix seconds> <pid>:<resident KB>:<footprint KB> ...`. The footprint (macOS's `footprint` tool: what the system
 * charges a process, graphics memory included, as iOS's memory limit does) is 0 where the tool is missing or says
 * nothing readable. Used by the Safari workflow (.github/workflows/safari.yml).
 *
 *   node apps/web/scripts/sample-memory.mjs [pattern] > memory.log &
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const hasFootprint = existsSync('/usr/bin/footprint');
/** The process's footprint in KB, or 0. */
function footprintKb(pid) {
  if (!hasFootprint) return 0;
  try {
    const out = execFileSync('/usr/bin/footprint', [pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const line = out.split('\n').find((l) => /footprint/i.test(l) && /\d\s*[KMG]B/.test(l));
    const m = line && /([\d.]+)\s*([KMG])B/.exec(line);
    return m ? Math.round(Number(m[1]) * { K: 1, M: 1024, G: 1024 * 1024 }[m[2]]) : 0;
  } catch {
    return 0;
  }
}

const pattern = new RegExp(process.argv[2] ?? 'com\\.apple\\.WebKit\\.WebContent');
for (;;) {
  const rows = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m && pattern.test(m[3]) && !m[3].includes('sample-memory'));
  console.log(`${Math.round(Date.now() / 1000)} ${rows.map((m) => `${m[1]}:${m[2]}:${footprintKb(m[1])}`).join(' ')}`);
  await new Promise((r) => setTimeout(r, 2000));
}
