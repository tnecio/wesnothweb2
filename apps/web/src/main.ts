import { mount } from 'svelte';
import '@wesnothweb2/ui/src/fonts.css';
import { accessibility, locale } from '@wesnothweb2/ui';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('missing #app element');

// Choose the language (saved, else the browser's) and load its catalogues before the first paint, so
// a Polish browser never flashes English. Never throws: English is the fallback.
// Font scale and orb colours from the saved preferences, before anything is drawn.
accessibility.init();

void locale.init().finally(() => mount(App, { target }));

// Dev-only hook for the browser scripts (apps/web/scripts/i18n-playthrough.mjs): switches language the way the picker does,
// for screens where a modal covers the menu (a dialogue line, say).
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __wesnothI18n: unknown }).__wesnothI18n = {
    setLanguage: (code: string) => locale.setLanguage(code),
    current: () => locale.current,
  };
}
