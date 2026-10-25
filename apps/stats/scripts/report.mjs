/**
 * Phase 32: one bug report, from the stats Worker's private R2 bucket.
 *
 *   node apps/stats/scripts/report.mjs <id> [--local] [--save <file.gz>] [--json]
 *
 * Prints the report as text: where in the game, what the player wrote, the error and the log. `--save` writes
 * the attached game as a gzipped save, which the game's Load > Upload... opens where the player was. `--json`
 * prints the stored report as it is.
 *
 * Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) for the deployed bucket; `--local` reads `wrangler dev --local`'s.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--save');
if (!id || !/^[\w-]+$/.test(id)) {
  console.error('usage: node apps/stats/scripts/report.mjs <id> [--local] [--save <file.gz>] [--json]');
  process.exit(2);
}
const where = args.includes('--local') ? '--local' : '--remote';
const savePath = args.includes('--save') ? args[args.indexOf('--save') + 1] : null;
const statsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const raw = execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `wesnoth-reports/reports/${id}.json`, where, '--pipe'], { cwd: statsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
const report = JSON.parse(raw);

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const c = report.context ?? {};
  const lines = [
    `Report ${report.id} (${report.kind}), received ${report.received}`,
    `Build: ${report.build}; language ${report.lang ?? '-'}; device ${report.device ?? '-'}`,
    `Browser: ${report.userAgent ?? '-'}`,
    `Where: ${c.campaign ?? '-'} / ${c.scenario ?? '-'}${c.scenarioName ? ` (${c.scenarioName})` : ''}, turn ${c.turn ?? '-'}; run ${c.run ?? '-'}`,
    `Page: ${c.page ?? '-'}`,
    `Contact: ${report.contact ?? '(none)'}`,
    '',
    'What happened:',
    report.description,
    ...(report.expected ? ['', 'Expected:', report.expected] : []),
    ...(report.error ? ['', `Error (${report.error.source ?? '?'}): ${report.error.message}`, report.error.stack ?? '(no stack)'] : []),
    ...(report.log?.length ? ['', `Log (${report.log.length} lines):`, ...report.log] : []),
    '',
    report.save !== undefined ? `The game is attached${savePath ? '' : ' (--save <file.gz> writes it out)'}.` : 'No game attached.',
  ];
  console.log(lines.join('\n'));
}

if (savePath) {
  if (report.save === undefined) {
    console.error('This report has no game attached.');
    process.exit(1);
  }
  // The game's own save format (`importSaveFile` reads gzipped JSON); the campaign comes from the report if the
  // save does not name it, so Upload files it under the right campaign.
  const save = { ...report.save, campaignId: report.save.campaignId ?? report.context?.campaign };
  fs.writeFileSync(savePath, zlib.gzipSync(JSON.stringify(save)));
  console.log(`Wrote ${savePath}: open it with Load > Upload... in the game.`);
}
