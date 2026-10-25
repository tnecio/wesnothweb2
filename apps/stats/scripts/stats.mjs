/**
 * Phase 32: what the opt-in gameplay statistics say (the stats Worker's D1, read through wrangler).
 *
 *   node apps/stats/scripts/stats.mjs [--days 30] [--local]
 *
 * Prints, for the last N days:
 *   - per scenario: runs, starts, victories, defeats, quits, loads, crashes, and the average turn at which
 *     players quit or lost;
 *   - where runs got stuck: the scenarios where a campaign run's last event is a quit or a defeat, and it never
 *     won there -- with how many times those runs started or loaded it (many attempts and no win is the
 *     pattern a bug often leaves);
 *   - crashes by signature (message and first code position), with the builds they were seen in;
 *   - the latest bug reports (fetch one with report.mjs).
 *
 * Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) for the deployed database; `--local` reads the one
 * `wrangler dev --local` keeps.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const days = Number(args.includes('--days') ? args[args.indexOf('--days') + 1] : 30);
const where = args.includes('--local') ? '--local' : '--remote';
if (!Number.isFinite(days) || days <= 0) throw new Error('--days takes a positive number');
const since = new Date(Date.now() - days * 86400000).toISOString();
const statsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs one SELECT on the stats database. `since` is the only value put into the SQL, and it is our own ISO date. */
function query(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'wesnoth-stats', where, '--json', '--command', sql], { cwd: statsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(out)[0].results;
}

const result = (field) => `json_extract(data, '$.${field}')`;

console.log(`\nPer scenario, since ${since.slice(0, 10)}:`);
console.table(
  query(`
    SELECT campaign, scenario,
      COUNT(DISTINCT run) AS runs,
      SUM(type = 'scenario_start') AS starts,
      SUM(type = 'scenario_end' AND ${result('result')} = 'victory') AS wins,
      SUM(type = 'scenario_end' AND ${result('result')} = 'defeat') AS defeats,
      SUM(type = 'quit') AS quits,
      SUM(type = 'game_load') AS loads,
      SUM(type = 'crash') AS crashes,
      ROUND(AVG(CASE WHEN type = 'quit' OR (type = 'scenario_end' AND ${result('result')} = 'defeat') THEN turn END), 1) AS turn_given_up
    FROM events
    WHERE received >= '${since}' AND campaign IS NOT NULL
    GROUP BY campaign, scenario
    ORDER BY campaign, scenario`),
);

console.log('\nWhere runs got stuck (last event a quit or defeat, never won there):');
console.table(
  query(`
    WITH per AS (
      SELECT run, campaign, scenario,
        SUM(type IN ('scenario_start', 'game_load')) AS attempts,
        MAX(type = 'scenario_end' AND ${result('result')} = 'victory') AS won,
        (SELECT e2.type || ':' || COALESCE(json_extract(e2.data, '$.result'), '') FROM events e2
          WHERE e2.run = e.run AND e2.campaign = e.campaign AND e2.scenario = e.scenario ORDER BY e2.id DESC LIMIT 1) AS last
      FROM events e
      WHERE run IS NOT NULL AND received >= '${since}'
      GROUP BY run, campaign, scenario)
    SELECT campaign, scenario, COUNT(*) AS stuck_runs, ROUND(AVG(attempts), 1) AS avg_attempts, MAX(attempts) AS most_attempts
    FROM per
    WHERE won = 0 AND (last = 'quit:' OR last = 'scenario_end:defeat')
    GROUP BY campaign, scenario
    ORDER BY stuck_runs DESC, avg_attempts DESC
    LIMIT 30`),
);

console.log('\nCrashes by signature:');
console.table(
  query(`
    SELECT ${result('signature')} AS signature, COUNT(*) AS times, COUNT(DISTINCT run) AS runs,
      MIN(build) AS first_build, MAX(build) AS last_build, MAX(received) AS last_seen
    FROM events
    WHERE type = 'crash' AND received >= '${since}'
    GROUP BY signature
    ORDER BY times DESC
    LIMIT 20`),
);

console.log('\nLatest bug reports (node apps/stats/scripts/report.mjs <id>):');
console.table(query(`SELECT id, kind, campaign, scenario, turn, has_save, substr(summary, 1, 60) AS summary FROM reports WHERE received >= '${since}' ORDER BY received DESC LIMIT 20`));
