/**
 * The interface's own clicks (`gui2`: `button.cpp`, `menu_button`, `slider`):
 * a push button says `button.wav`, a checkbox `checkbox.wav`, a slider that
 * was let go of `slider.wav`, a menu opening `expand.wav` and closing
 * `contract.wav`, a menu entry `select.wav`. One delegated listener covers
 * every dialog and menu, and disabled controls stay silent.
 */
import { GAME_SOUNDS } from '@wesnothweb2/engine';
import type { AudioEngine } from './audioEngine.js';

const CONTROLS = 'button, input[type="checkbox"], input[type="range"]';

function isDisabled(el: Element): boolean {
  return el.matches(':disabled') || el.closest('[aria-disabled="true"]') !== null;
}

/** Starts the interface sounds; returns the function that stops them. */
export function installUiSounds(audio: AudioEngine): () => void {
  const onClick = (event: MouseEvent): void => {
    const control = (event.target as Element | null)?.closest?.(CONTROLS);
    if (!control || isDisabled(control)) return;
    if (control.matches('input[type="range"]')) return;
    if (control.matches('input[type="checkbox"]')) {
      audio.playUi(GAME_SOUNDS.checkboxRelease);
    } else if (control.matches('.menu-button')) {
      // The menu has just toggled: opening expands, closing contracts.
      setTimeout(() => audio.playUi(control.classList.contains('open') ? GAME_SOUNDS.menuExpand : GAME_SOUNDS.menuContract), 0);
    } else if (control.closest('.dropdown')) {
      audio.playUi(GAME_SOUNDS.menuSelect);
    } else {
      audio.playUi(GAME_SOUNDS.buttonPress);
    }
  };
  const onChange = (event: Event): void => {
    const control = event.target as Element | null;
    if (control?.matches?.('input[type="range"]') && !isDisabled(control)) audio.playUi(GAME_SOUNDS.sliderAdjust);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
  };
}
