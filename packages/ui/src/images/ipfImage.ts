/**
 * Menu-side images with Wesnoth image path functions (Phase 21): a campaign's `icon=`, a difficulty's
 * `image=` and the laurel blitted over it carry `~RC(magenta>red)`, `~CROP(...)`, `~SCALE(...)`, `~BLIT(...)`.
 * The board composites those inside the renderer; a DOM `<img>` cannot, so this runs the renderer's own
 * `Compositor` (same ops, same team-colour tables) on the main thread and hands back an object URL. Results
 * are cached by reference, and a plain path with no functions is just its file URL.
 */
import { Compositor, imageUrl, setEngineImageBaseUrl, setImageBaseUrl } from '@wesnothweb2/renderer';
import { rootMenuImage } from './rootMenuImage.js';
import { fetchTeamColors } from '../teamColorsCache.js';
import { ENGINE_IMAGES, GAME_IMAGES } from '../gameData.js';

let compositor: Compositor | null = null;
const results = new Map<string, Promise<string | null>>();

async function getCompositor(): Promise<Compositor> {
  if (!compositor) {
    // The same roots the game uses (`GameShell`), set here so the title screen does not depend on it having loaded.
    setImageBaseUrl(GAME_IMAGES);
    setEngineImageBaseUrl(ENGINE_IMAGES);
    compositor = new Compositor();
    compositor.setColorData(await fetchTeamColors());
  }
  return compositor;
}

/** The URL to show for `ref`; null if the image cannot be built (a missing file: the caller shows nothing). */
export function ipfImageUrl(ref: string): Promise<string | null> {
  const rooted = rootMenuImage(ref);
  if (!rooted.includes('~')) return Promise.resolve(imageUrl(rooted));
  let result = results.get(rooted);
  if (!result) {
    result = (async () => {
      try {
        const canvas = await (await getCompositor()).render(rooted);
        if (!canvas) return null;
        const blob =
          typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas
            ? await canvas.convertToBlob({ type: 'image/png' })
            : await new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, 'image/png'));
        return blob ? URL.createObjectURL(blob) : null;
      } catch (err) {
        console.warn(`[menu] could not build image "${ref}":`, err);
        return null;
      }
    })();
    results.set(rooted, result);
  }
  return result;
}
