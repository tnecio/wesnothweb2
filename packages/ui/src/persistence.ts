/**
 * Browser-side save/load storage: gzip-compressed JSON in IndexedDB, per
 * the original Phase 5 scope ("save/load ... gzipped, in IndexedDB").
 *
 * What's saved is `GameSession`'s own live-state snapshot (see
 * `gameSession.ts`'s `SaveGameData`/`toSaveData`/`loadSaveData`) -- unit
 * positions/hp/moves, team gold, turn/side, and whether startup events
 * already ran -- NOT a full Wesnoth-compatible save file (no `[replay]`,
 * no WML variable store, no undo stack). This project ships exactly one
 * scenario today, so a save only ever needs to reload against that same
 * `GameBoardSnapshot`; `scenarioId` is stored and checked on load purely
 * as a sanity guard against loading a save file for the wrong scenario
 * once more than one exists (Phase 6).
 *
 * Compression via the native `CompressionStream`/`DecompressionStream`
 * APIs (Chromium/Firefox/Safari all ship these) rather than pulling in a
 * gzip library -- one less dependency for a few hundred bytes of JSON.
 */

const DB_NAME = 'wesnothweb2-saves';
const DB_VERSION = 1;
const STORE_NAME = 'saves';

export interface SaveMeta {
  name: string;
  scenarioId: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

async function gzipJson(data: unknown): Promise<Blob> {
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(bytes).then(() => writer.close());
  return await new Response(cs.readable).blob();
}

async function gunzipJson<T>(blob: Blob): Promise<T> {
  const ds = new DecompressionStream('gzip');
  const decompressed = blob.stream().pipeThrough(ds);
  const text = await new Response(decompressed).text();
  return JSON.parse(text) as T;
}

interface StoredSave {
  name: string;
  scenarioId: string;
  savedAt: number;
  blob: Blob;
}

/** Writes (or overwrites) a named save slot. */
export async function saveGame(name: string, scenarioId: string, data: unknown): Promise<void> {
  const blob = await gzipJson(data);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const record: StoredSave = { name, scenarioId, savedAt: Date.now(), blob };
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('save transaction failed'));
  });
  db.close();
}

/** Reads a named save slot's decompressed payload, or `null` if it doesn't exist. */
export async function loadGame<T>(name: string): Promise<{ scenarioId: string; savedAt: number; data: T } | null> {
  const db = await openDb();
  const record = await new Promise<StoredSave | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(name);
    req.onsuccess = () => resolve(req.result as StoredSave | undefined);
    req.onerror = () => reject(req.error ?? new Error('load transaction failed'));
  });
  db.close();
  if (!record) return null;
  const data = await gunzipJson<T>(record.blob);
  return { scenarioId: record.scenarioId, savedAt: record.savedAt, data };
}

/** Lists every save slot's metadata (not the payload), most recent first. */
export async function listSaves(): Promise<SaveMeta[]> {
  const db = await openDb();
  const records = await new Promise<StoredSave[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as StoredSave[]);
    req.onerror = () => reject(req.error ?? new Error('list transaction failed'));
  });
  db.close();
  return records
    .map(({ name, scenarioId, savedAt }) => ({ name, scenarioId, savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteSave(name: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('delete transaction failed'));
  });
  db.close();
}
