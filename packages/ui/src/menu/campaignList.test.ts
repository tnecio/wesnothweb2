import { describe, expect, it } from 'vitest';
import type { CampaignInfo } from '../save/campaign.js';
import { campaignStart, dateBefore, matchesSearch, nextSort, parseIrdyaDate, searchWords, sortCampaigns } from './campaignList.js';

const c = (id: string, extra: Partial<CampaignInfo> = {}): CampaignInfo => ({ id, name: id, ...extra });
const ids = (list: CampaignInfo[]): string[] => list.map((x) => x.id);

describe('Irdya dates', () => {
  it('reads year and epoch', () => {
    expect(parseIrdyaDate('501 YW')).toEqual({ epoch: 1, year: 501 });
    expect(parseIrdyaDate('1000 AF')).toEqual({ epoch: 3, year: 1000 });
    expect(parseIrdyaDate('12 BW')).toEqual({ epoch: 0, year: 12 });
    expect(parseIrdyaDate('300')).toEqual({ epoch: 1, year: 300 });
    expect(parseIrdyaDate('')).toBeNull();
    expect(parseIrdyaDate(undefined)).toBeNull();
  });
  it('orders by epoch, with BW and BF counting backwards', () => {
    const d = (s: string) => parseIrdyaDate(s)!;
    expect(dateBefore(d('900 BW'), d('10 BW'))).toBe(true); // earlier in time = larger BW year
    expect(dateBefore(d('10 BW'), d('1 YW'))).toBe(true);
    expect(dateBefore(d('500 YW'), d('501 YW'))).toBe(true);
    expect(dateBefore(d('501 YW'), d('1000 AF'))).toBe(true);
    expect(dateBefore(d('50 BF'), d('10 BF'))).toBe(true);
    expect(dateBefore(d('10 BF'), d('50 BF'))).toBe(false);
  });
  it('takes start_year before year', () => {
    expect(campaignStart(c('a', { startYear: '626 YW', endYear: '627 YW' }))).toEqual({ epoch: 1, year: 626 });
    expect(campaignStart(c('b', { year: '363 YW' }))).toEqual({ epoch: 1, year: 363 });
    expect(campaignStart(c('c'))).toBeNull();
  });
});

describe('sorting', () => {
  const list = [c('dw', { rank: 110, startYear: '626 YW' }), c('l', { rank: 50, year: '501 YW' }), c('tb', { rank: 70, year: '363 YW' }), c('utbs', { rank: 205, year: '1000 AF' }), c('dbg')];
  const name = (x: CampaignInfo): string => x.id;
  it('by rank ascending is the default, unranked last', () => {
    expect(ids(sortCampaigns(list, { key: 'rank', ascending: true }, name))).toEqual(['l', 'tb', 'dw', 'utbs', 'dbg']);
  });
  it('by timeline puts undated campaigns last in either direction', () => {
    expect(ids(sortCampaigns(list, { key: 'timeline', ascending: true }, name))).toEqual(['tb', 'l', 'dw', 'utbs', 'dbg']);
    expect(ids(sortCampaigns(list, { key: 'timeline', ascending: false }, name))).toEqual(['utbs', 'dw', 'l', 'tb', 'dbg']);
  });
  it('by name ignores case and follows the given locale', () => {
    const named = [c('b', { name: 'banana' }), c('a', { name: 'Apple' }), c('c', { name: 'cherry' })];
    expect(ids(sortCampaigns(named, { key: 'name', ascending: true }, (x) => x.name))).toEqual(['a', 'b', 'c']);
    expect(ids(sortCampaigns(named, { key: 'name', ascending: false }, (x) => x.name))).toEqual(['c', 'b', 'a']);
    // The player's own alphabet: Swedish puts Ö after Z, English sorts it with O.
    const swedish = [c('z', { name: 'Zebra' }), c('o', { name: 'Örebro' }), c('p', { name: 'Olof' })];
    expect(ids(sortCampaigns(swedish, { key: 'name', ascending: true }, (x) => x.name, 'sv'))).toEqual(['p', 'z', 'o']);
    expect(ids(sortCampaigns(swedish, { key: 'name', ascending: true }, (x) => x.name, 'en'))).toEqual(['p', 'o', 'z']);
  });
  it('cycles a header ascending, descending, then back to rank', () => {
    const s0 = { key: 'rank' as const, ascending: true };
    const s1 = nextSort(s0, 'name');
    const s2 = nextSort(s1, 'name');
    const s3 = nextSort(s2, 'name');
    expect([s1, s2, s3]).toEqual([{ key: 'name', ascending: true }, { key: 'name', ascending: false }, { key: 'rank', ascending: true }]);
    expect(nextSort(s2, 'timeline')).toEqual({ key: 'timeline', ascending: true });
  });
});

describe('the filter box', () => {
  it('needs every word somewhere in the searchable text, ignoring case', () => {
    const texts = ['Dead Water', 'You are Kai Krellis, son of the merman king', 'DW'];
    expect(matchesSearch(searchWords('dead kai'), texts)).toBe(true);
    expect(matchesSearch(searchWords('dead nonsense'), texts)).toBe(false);
    expect(matchesSearch(searchWords('  dw '), texts)).toBe(true);
    expect(matchesSearch([], texts)).toBe(true);
  });
});
