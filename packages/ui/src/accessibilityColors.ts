/**
 * The team colours offered for the orbs (upstream's own preference dialog lists these), each with its
 * `[color_range]` mid shade for the swatch and its name as upstream's `wesnoth` catalogue has it, so
 * every language names them already. Colour ids are `data/core/team-colors.cfg`'s; the renderer
 * draws the orb with `~RC(magenta>id)`.
 */

import { tw } from './i18n/locale.js';

export interface OrbColorChoice {
  readonly id: string;
  readonly name: () => string;
  /** `[color_range]` mid shade, as a CSS colour. */
  readonly css: string;
}

export const ORB_COLOR_CHOICES: readonly OrbColorChoice[] = [
  { id: 'red', name: () => tw('Red'), css: 'rgb(255, 0, 0)' },
  { id: 'lightred', name: () => tw('Light Red'), css: 'rgb(209, 98, 13)' },
  { id: 'darkred', name: () => tw('Dark Red'), css: 'rgb(138, 8, 8)' },
  { id: 'blue', name: () => tw('Blue'), css: 'rgb(46, 65, 155)' },
  { id: 'lightblue', name: () => tw('Light blue'), css: 'rgb(0, 164, 255)' },
  { id: 'darkblue', name: () => tw('Dark blue'), css: 'rgb(14, 34, 112)' },
  { id: 'green', name: () => tw('Green'), css: 'rgb(98, 182, 100)' },
  { id: 'brightgreen', name: () => tw('Bright green'), css: 'rgb(140, 255, 0)' },
  { id: 'purple', name: () => tw('Purple'), css: 'rgb(147, 0, 157)' },
  { id: 'black', name: () => tw('Black'), css: 'rgb(90, 90, 90)' },
  { id: 'brown', name: () => tw('Brown'), css: 'rgb(148, 80, 39)' },
  { id: 'orange', name: () => tw('Orange'), css: 'rgb(255, 126, 0)' },
  { id: 'brightorange', name: () => tw('Bright orange'), css: 'rgb(255, 198, 0)' },
  { id: 'white', name: () => tw('White'), css: 'rgb(225, 225, 225)' },
  { id: 'teal', name: () => tw('Teal'), css: 'rgb(48, 203, 192)' },
  { id: 'gold', name: () => tw('color^Gold'), css: 'rgb(255, 243, 90)' },
  { id: 'yellow', name: () => tw('Yellow'), css: 'rgb(231, 237, 45)' },
  { id: 'pink', name: () => tw('Pink'), css: 'rgb(255, 192, 203)' },
];
