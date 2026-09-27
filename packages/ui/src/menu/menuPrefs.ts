/**
 * Title-screen preferences that outlive a page load: whether the tip panel shows (`prefs::show_tips`, default on).
 * Kept in localStorage (a per-viewer convenience); a missing or blocked store just means the default.
 */
import { createSubscriber } from 'svelte/reactivity';

const KEY = 'wesnothweb2.menu.showTips';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'no';
  } catch {
    return true;
  }
}

class MenuPrefs {
  #value = read();
  #subscribe = createSubscriber((update) => {
    this.#notify = update;
    return () => {
      this.#notify = () => {};
    };
  });
  #notify: () => void = () => {};

  get showTips(): boolean {
    this.#subscribe();
    return this.#value;
  }

  setShowTips(on: boolean): void {
    this.#value = on;
    try {
      localStorage.setItem(KEY, on ? 'yes' : 'no');
    } catch {
      /* the choice lasts for this page only */
    }
    this.#notify();
  }
}

export const menuPrefs = new MenuPrefs();
