/**
 * Where a music or sound file is served from -- the binary-path search
 * (`filesystem::get_binary_file_location`): the running campaign's binary
 * paths first (its own directory, then resources it includes such as
 * `internal/Weather`), then core. `audioFiles.json` (generated) says what exists.
 */
import audioFiles from '../audioFiles.json';
import { ENGINE_SOUNDS, GAME_IMAGES, servedAudioPath } from '../gameData.js';

export type AudioKind = 'music' | 'sounds';

const index: Record<AudioKind, Record<string, Set<string>>> = { music: {}, sounds: {} };
for (const kind of ['music', 'sounds'] as const) {
  for (const [root, files] of Object.entries(audioFiles[kind] as Record<string, string[]>)) index[kind][root] = new Set(files);
}

/** The URL of `file`, or null if no such file ships. `campaign` is the running campaign's wesnoth id. */
export function audioUrl(kind: AudioKind, file: string, campaign?: string): string | null {
  const url = sourceUrl(kind, file, campaign);
  return url && servedAudioPath(url);
}

const binaryPaths = audioFiles.binaryPaths as Record<string, string[]>;

function sourceUrl(kind: AudioKind, file: string, campaign?: string): string | null {
  for (const dir of campaign ? (binaryPaths[campaign] ?? []) : []) {
    if (index[kind][dir]?.has(file)) return `${GAME_IMAGES}/${dir}/${kind}/${file}`;
  }
  if (index[kind]['core']?.has(file)) return `${GAME_IMAGES}/core/${kind}/${file}`;
  if (kind === 'sounds' && index[kind]['engine']?.has(file)) return `${ENGINE_SOUNDS}/${file}`;
  return null;
}

/** Whether `file` exists in core or any campaign (the playlist checks before it knows which campaign runs). */
export function audioExists(kind: AudioKind, file: string): boolean {
  return Object.values(index[kind]).some((files) => files.has(file));
}
