/**
 * Where a music or sound file is served from -- the binary-path search
 * (`filesystem::get_binary_file_location`): the running campaign's own
 * directory first, then core. `audioFiles.json` (generated) says what exists.
 */
import audioFiles from '../audioFiles.json';

export type AudioKind = 'music' | 'sounds';

const index: Record<AudioKind, Record<string, Set<string>>> = { music: {}, sounds: {} };
for (const kind of ['music', 'sounds'] as const) {
  for (const [root, files] of Object.entries(audioFiles[kind] as Record<string, string[]>)) index[kind][root] = new Set(files);
}

/** The URL of `file`, or null if no such file ships. `campaign` is the running campaign's wesnoth id. */
export function audioUrl(kind: AudioKind, file: string, campaign?: string): string | null {
  if (campaign && index[kind][campaign]?.has(file)) return `/game-images/campaigns/${campaign}/${kind}/${file}`;
  if (index[kind]['core']?.has(file)) return `/game-images/core/${kind}/${file}`;
  return null;
}

/** Whether `file` exists in core or any campaign (the playlist checks before it knows which campaign runs). */
export function audioExists(kind: AudioKind, file: string): boolean {
  return Object.values(index[kind]).some((files) => files.has(file));
}
