/**
 * Node-only: reading built scenario files from disk, for tests and build scripts (the browser fetches them,
 * see `packages/ui/src/scenarioFetch.ts`). Not exported from the package index, so `node:fs` never reaches
 * the browser bundle.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GameBoardSnapshot } from './gameBoardSnapshot.js';
import { assembleSnapshot, type SnapshotDatabase, type StoredSnapshot } from './snapshotDatabase.js';

const databases = new Map<string, SnapshotDatabase>();

function readDatabase(file: string): SnapshotDatabase {
  let db = databases.get(file);
  if (!db) {
    db = JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotDatabase;
    databases.set(file, db);
  }
  return db;
}

/**
 * The complete snapshot in `file` (`.../scenarios/<campaignDir>/<id>.json`), with its shared databases
 * merged back in. Files built before the split (no `databases`) are returned as they are. Databases are
 * cached per path, so reading many scenarios parses each one once.
 */
export function readScenarioSnapshot(file: string): GameBoardSnapshot {
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredSnapshot;
  if (!stored.databases) return stored;
  const root = path.dirname(path.dirname(file));
  return assembleSnapshot(stored, stored.databases.map((name) => readDatabase(path.join(root, name))));
}

/** Forgets cached databases (after a rebuild rewrote them). */
export function clearSnapshotDatabaseCache(): void {
  databases.clear();
}
