import { mount } from 'svelte';
import { locale } from '@wesnothweb2/ui';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('missing #app element');

// Choose the language (saved, else the browser's) and load its catalogues before the first paint, so
// a Polish browser never flashes English. Never throws: English is the fallback.
void locale.init().finally(() => mount(App, { target }));
