import { mount } from 'svelte';
import '@wesnothweb2/ui/src/fonts.css';
import { accessibility, installErrorReporting, loadDataManifest, locale } from '@wesnothweb2/ui';
import App from './App.svelte';

// First, so an error anywhere after this reaches the error screen (Phase 28 S6) instead of a frozen page.
installErrorReporting();

// `?crashtest` throws a few seconds in, to check the error screen on a deployed build.
if (new URLSearchParams(location.search).has('crashtest')) {
  setTimeout(() => {
    throw new Error('Crash test (?crashtest): an error thrown on purpose.');
  }, 4000);
}

const target = document.getElementById('app');
if (!target) throw new Error('missing #app element');

// Choose the language (saved, else the browser's) and load its catalogues before the first paint, so
// a Polish browser never flashes English. Never throws: English is the fallback.
// Font scale and orb colours from the saved preferences, before anything is drawn.
accessibility.init();

// A production build first learns where its data files are (content-hashed paths; see dataUrls.ts).
void loadDataManifest()
  .then(() => locale.init())
  .finally(() => mount(App, { target }));

// Dev-only hook for the browser scripts (apps/web/scripts/i18n-playthrough.mjs): switches language the way the picker does,
// for screens where a modal covers the menu (a dialogue line, say).
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __wesnothI18n: unknown }).__wesnothI18n = {
    setLanguage: (code: string) => locale.setLanguage(code),
    current: () => locale.current,
  };
}
