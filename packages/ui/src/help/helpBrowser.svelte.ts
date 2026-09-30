/**
 * Opening the help browser from anywhere (Phase 24): upstream's `help::show_help(topic)`,
 * `show_unit_description` and `show_terrain_description`. The page that hosts the browser (the game, or the
 * main menu) shows `HelpBrowser` while a request is open; a new request while it is open goes to the new page.
 */
import { DEFAULT_SHOW_TOPIC } from './helpCommon.js';

export type HelpRequest =
  /** A topic by id (`..units`, `unit_Elvish Fighter`...). */
  | { readonly topic: string }
  /** A unit type's page (`help::show_unit_description`), `variation` being the unit's `[variation]`, if any. */
  | { readonly unitType: string; readonly variation: string }
  /** A terrain's page (`help::show_terrain_description`), by terrain code (`Gg`, `Gg^Fp`...). */
  | { readonly terrain: string };

class HelpBrowserRequests {
  /** What was asked for, or null while the help is closed. */
  request = $state<HelpRequest | null>(null);
  /** Bumped on every request, so asking again for the same page still goes to it. */
  serial = $state(0);

  get isOpen(): boolean {
    return this.request !== null;
  }

  private ask(request: HelpRequest): void {
    this.request = request;
    this.serial++;
  }

  /** `help::show_help(topic)`: the introduction by default. */
  open(topic: string = DEFAULT_SHOW_TOPIC): void {
    this.ask({ topic: topic || DEFAULT_SHOW_TOPIC });
  }

  openUnitType(unitType: string, variation = ''): void {
    this.ask({ unitType, variation });
  }

  openTerrain(terrain: string): void {
    this.ask({ terrain });
  }

  close(): void {
    this.request = null;
  }
}

export const helpBrowser = new HelpBrowserRequests();
