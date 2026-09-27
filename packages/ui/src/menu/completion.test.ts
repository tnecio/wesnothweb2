import { describe, expect, it } from 'vitest';
import { TString } from '@wesnothweb2/engine';
import type { CampaignInfo } from '../save/campaign.js';
import { campaignLaurel, difficultyLaurel, isCampaignCompleted, isCompletedAt, passesCompletionFilter, summarizeCompletion, withCompleted, type CompletionFilter } from './completion.js';

const d = (define: string) => ({ define, label: TString.literal(define), description: TString.literal('') });
const camp = (...defines: string[]): CampaignInfo => ({ id: 'c', assetDir: 'c', name: 'C', difficulties: defines.map(d) });

describe('completion record', () => {
  it('records difficulties per campaign without mutating', () => {
    const a = withCompleted({}, 'c', 'EASY');
    expect(isCampaignCompleted(a, 'c')).toBe(true);
    expect(isCompletedAt(a, 'c', 'EASY')).toBe(true);
    expect(isCompletedAt(a, 'c', 'HARD')).toBe(false);
    expect(isCampaignCompleted(a, 'other')).toBe(false);
    expect(withCompleted(a, 'c', 'EASY')).toBe(a);
    expect(withCompleted(a, 'c', 'HARD').c).toEqual(['EASY', 'HARD']);
    expect(a.c).toEqual(['EASY']);
  });
});

describe('the campaign list laurel (campaign_selection.cpp add_campaign_to_tree)', () => {
  const three = camp('EASY', 'NORMAL', 'HARD');
  it('is none until completed', () => expect(campaignLaurel(three, {})).toBeNull());
  it('is gold when the last difficulty was won', () => {
    expect(campaignLaurel(three, { c: ['HARD'] })).toBe('hardest');
    expect(campaignLaurel(three, { c: ['EASY', 'HARD'] })).toBe('hardest');
  });
  it('is bronze only when just the first of several was won', () => {
    expect(campaignLaurel(three, { c: ['EASY'] })).toBe('easy');
    expect(campaignLaurel(three, { c: ['EASY', 'NORMAL'] })).toBe('normal');
  });
  it('is silver for a middle difficulty', () => expect(campaignLaurel(three, { c: ['NORMAL'] })).toBe('normal'));
  it('is gold for a campaign with a single difficulty', () => expect(campaignLaurel(camp('NORMAL'), { c: ['NORMAL'] })).toBe('hardest'));
  it('is silver for a campaign with no difficulties (nothing to be the hardest)', () => {
    expect(campaignLaurel({ id: 'c', assetDir: 'c', name: 'C' }, { c: [''] })).toBe('normal');
  });
  it('treats the last listed difficulty as the hardest, whatever it is called (UtBS lists HARD after NIGHTMARE)', () => {
    const utbs = camp('EASY', 'NORMAL', 'NIGHTMARE', 'HARD');
    expect(campaignLaurel(utbs, { c: ['NIGHTMARE'] })).toBe('normal');
    expect(campaignLaurel(utbs, { c: ['HARD'] })).toBe('hardest');
  });
});

describe('the difficulty menu laurel (campaign_difficulty.cpp)', () => {
  it('is gold for the last, bronze for the first, silver between', () => {
    expect([0, 1, 2].map((i) => difficultyLaurel(i, 3))).toEqual(['easy', 'normal', 'hardest']);
  });
  it('is gold when there is only one difficulty', () => expect(difficultyLaurel(0, 1)).toBe('hardest'));
  it('has no silver with two difficulties', () => expect([0, 1].map((i) => difficultyLaurel(i, 2))).toEqual(['easy', 'hardest']));
});

describe('the completion filter', () => {
  const sel = (...f: CompletionFilter[]) => new Set<CompletionFilter>(f);
  const three = camp('EASY', 'NORMAL', 'HARD');
  it('shows campaigns by completion state', () => {
    const none = summarizeCompletion(three, {});
    const bronze = summarizeCompletion(three, { c: ['EASY'] });
    const silver = summarizeCompletion(three, { c: ['NORMAL'] });
    const gold = summarizeCompletion(three, { c: ['HARD'] });
    expect(passesCompletionFilter(none, sel('not-completed'))).toBe(true);
    expect(passesCompletionFilter(none, sel('all-completed', 'gold'))).toBe(false);
    expect(passesCompletionFilter(bronze, sel('bronze'))).toBe(true);
    expect(passesCompletionFilter(bronze, sel('silver', 'gold', 'not-completed'))).toBe(false);
    expect(passesCompletionFilter(silver, sel('silver'))).toBe(true);
    expect(passesCompletionFilter(gold, sel('gold'))).toBe(true);
    expect(passesCompletionFilter(gold, sel('all-completed'))).toBe(true);
    expect(passesCompletionFilter(gold, sel())).toBe(false);
  });
});
