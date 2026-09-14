/**
 * Phase 16 N7: the campaign outro's screens, as `gui2::dialogs::outro`'s
 * constructor builds them (`src/gui/dialogs/outro.cpp`): the end text
 * (default "The End"), then -- with `end_credits` -- the campaign name and
 * each credits section split into chunks of 5 names, the section title on
 * its first chunk only.
 */
import type { CampaignCredits } from './storyImages.js';

export interface OutroLine {
  readonly text: string;
  /** `large` for the campaign name, `small` for credited names (upstream's `xx-small` spans). */
  readonly size: 'normal' | 'large' | 'small';
}

export interface OutroScreen {
  readonly lines: readonly OutroLine[];
}

/** How long each screen fades in and out (hardcoded upstream). */
export const OUTRO_FADE_MS = 500;
/** Hold time when `end_text_duration` is 0 or absent. */
export const OUTRO_DEFAULT_DURATION_MS = 3500;

const CHUNK_SIZE = 5;

export function buildOutroScreens(endText: string | undefined, showCredits: boolean, campaign: CampaignCredits | undefined): OutroScreen[] {
  const screens: OutroScreen[] = [{ lines: [{ text: endText ? endText : 'The End', size: 'normal' }] }];
  if (!showCredits || !campaign) return screens;

  screens.push({ lines: [{ text: campaign.name, size: 'large' }] });
  for (const section of campaign.credits) {
    if (section.names.length === 0) continue;
    for (let start = 0; start < section.names.length; start += CHUNK_SIZE) {
      const lines: OutroLine[] = start === 0 ? [{ text: section.title, size: 'normal' }] : [];
      for (const name of section.names.slice(start, start + CHUNK_SIZE)) lines.push({ text: name, size: 'small' });
      screens.push({ lines });
    }
  }
  return screens;
}

/** `end_text_duration`, with upstream's 3500 ms default for 0. */
export function outroHoldMs(endTextDuration: number | undefined): number {
  return endTextDuration && endTextDuration > 0 ? endTextDuration : OUTRO_DEFAULT_DURATION_MS;
}
