/**
 * Browser-side save storage: gzip-compressed JSON in IndexedDB, one
 * record per named save.
 *
 * What's stored is `GameSession`'s own `SaveGameData` (see `gameSession.
 * ts`), which since save version 2 is a complete capture of the live
 * game. It is NOT the Wesnoth file format -- that conversion happens only
 * when a save is downloaded or uploaded, in `save/wesnothSave.ts`, so
 * nothing on the hot path has to deal in WML.
 *
 * Each record carries enough metadata to list, filter and identify a save
 * without decompressing it (campaign, scenario, turn, kind, timestamp),
 * which is what lets the manager show a real list and what lets a save be
 * resumed from outside the scenario it was taken in.
 *
 * Compression via the native `CompressionStream`/`DecompressionStream`
 * APIs (Chromium/Firefox/Safari all ship these) rather than pulling in a
 * gzip library -- one less dependency, and the stored value is then
 * already a gzip `Blob`, which is exactly what a download needs.
 */

const DB_NAME = 'wesnothweb2-saves';
/** Bumped to 2 when saves gained campaign/turn/kind metadata (Phase 26). */
const DB_VERSION = 2;
const STORE_NAME = 'saves';
const SETTINGS_STORE = 'settings';

/** Why a save exists, mirroring upstream's three save flavours (`savegame.hpp`). */
export type SaveKind = 'manual' | 'autosave' | 'scenario-start';

export interface SaveMeta {
  name: string;
  scenarioId: string;
  savedAt: number;
  /** All optional on read: a record written before Phase 26 has none of them. */
  campaignId?: string;
  scenarioName?: string;
  turnNumber?: number;
  /** The `label=` a real Wesnoth save would carry (`<abbrev>-<scenario name>`). */
  label?: string;
  kind?: SaveKind;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Version 1 -> 2 needs no data migration: every field added is
      // optional on read, and `listSaves` fills in what a pre-Phase-26
      // record cannot know (it defaults to a manual save of unknown
      // campaign). Creating the stores is all that is required.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
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

interface StoredSave extends SaveMeta {
  blob: Blob;
}

/** Everything but the name and timestamp, which `saveGame` supplies itself. */
export type SaveDetails = Omit<SaveMeta, 'name' | 'savedAt'>;

/** Writes (or overwrites) a named save slot. */
export async function saveGame(name: string, details: SaveDetails, data: unknown): Promise<void> {
  const blob = await gzipJson(data);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const record: StoredSave = { ...details, name, savedAt: Date.now(), blob };
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('save transaction failed'));
  });
  db.close();
}

/** Reads a named save slot's decompressed payload and metadata, or `null` if it doesn't exist. */
export async function loadGame<T>(name: string): Promise<{ meta: SaveMeta; data: T } | null> {
  const db = await openDb();
  const record = await new Promise<StoredSave | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(name);
    req.onsuccess = () => resolve(req.result as StoredSave | undefined);
    req.onerror = () => reject(req.error ?? new Error('load transaction failed'));
  });
  db.close();
  if (!record) return null;
  const { blob, ...meta } = record;
  return { meta, data: await gunzipJson<T>(blob) };
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
    .map(({ blob: _blob, ...meta }) => meta)
    .sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Renames a slot, keeping its payload and metadata. A no-op if `from`
 * does not exist; throws rather than clobber an existing `to`, since the
 * caller (the manager dialog) can ask for a different name but cannot
 * undo a lost save.
 */
export async function renameSave(from: string, to: string): Promise<void> {
  if (from === to) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const existing = store.get(to);
    existing.onsuccess = () => {
      if (existing.result !== undefined) {
        reject(new Error(`A save called "${to}" already exists.`));
        tx.abort();
        return;
      }
      const req = store.get(from);
      req.onsuccess = () => {
        const record = req.result as StoredSave | undefined;
        if (!record) return; // nothing to rename; tx completes as a no-op
        store.delete(from);
        store.put({ ...record, name: to });
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('rename transaction failed'));
  });
  db.close();
}

/** The manager's own settings (currently just the autosave cap), kept beside the saves. */
export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await openDb();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, 'readonly');
    const req = tx.objectStore(SETTINGS_STORE).get(key);
    req.onsuccess = () => resolve((req.result as { key: string; value: T } | undefined)?.value);
    req.onerror = () => reject(req.error ?? new Error('settings read failed'));
  });
  db.close();
  return value ?? fallback;
}

export async function writeSetting<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, 'readwrite');
    tx.objectStore(SETTINGS_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('settings write failed'));
  });
  db.close();
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
