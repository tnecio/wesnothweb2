import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { campaignCredits, changeScrollSpeed, creditsBackground, creditsLines, type CreditsJson } from './credits.js';

const data: CreditsJson = {
  backgrounds: ['data/core/images/story/a.webp', 'data/core/images/story/b.webp'],
  groups: [
    { images: [], sections: [{ title: 'Programming', names: ['Ann', 'Bob'] }] },
    { images: [], sort: true, sections: [{ title: 'Zulu Translation', names: ['Z'] }, { title: 'Afrikaans Translation', names: ['A'] }] },
    { id: 'Dead_Water', header: 'Dead Water', images: ['story/dw.webp'], sections: [{ title: 'Campaign Design', names: ['Doc'] }] },
  ],
};
const say = (t: { str(): string }): string => t.str();

describe('creditsLines', () => {
  it('lists each group with its header, section titles and names', () => {
    const lines = creditsLines(data, say);
    expect(lines.filter((l) => l.kind !== 'gap').map((l) => (l as { text: string }).text)).toEqual([
      'Programming', 'Ann', 'Bob', 'Afrikaans Translation', 'A', 'Zulu Translation', 'Z', 'Dead Water', 'Campaign Design', 'Doc',
    ]);
    expect(lines[0]).toEqual({ kind: 'gap' });
    expect(lines.find((l) => l.kind === 'header')).toEqual({ kind: 'header', text: 'Dead Water' });
  });
  it('puts the focused campaign first', () => {
    const lines = creditsLines(data, say, undefined, 'Dead_Water');
    expect(lines.find((l) => l.kind === 'header')).toBeDefined();
    expect((lines.filter((l) => l.kind === 'title')[0] as { text: string }).text).toBe('Campaign Design');
  });
  it('sorts only sort=yes groups, by the given comparison', () => {
    const titles = (creditsLines(data, say, (a, b) => b.localeCompare(a)).filter((l) => l.kind === 'title') as { text: string }[]).map((l) => l.text);
    expect(titles).toEqual(['Programming', 'Zulu Translation', 'Afrikaans Translation', 'Campaign Design']);
  });
});

describe('campaignCredits (the outro)', () => {
  it("is the campaign's group with its name and sections", () => {
    expect(campaignCredits(data, 'Dead_Water', say)).toEqual({ name: 'Dead Water', credits: [{ title: 'Campaign Design', names: ['Doc'] }] });
  });
  it('is undefined for a campaign without credits', () => {
    expect(campaignCredits(data, undefined, say)).toBeUndefined();
    expect(campaignCredits(data, 'Nope', say)).toBeUndefined();
  });
});

describe('background and speed', () => {
  it("uses the campaign's own pictures when it has some, else the title pictures", () => {
    expect(creditsBackground(data, () => 0, 'Dead_Water')).toBe('story/dw.webp');
    expect(creditsBackground(data, (max) => max)).toBe('data/core/images/story/b.webp');
    expect(creditsBackground({ backgrounds: [], groups: [] }, () => 0)).toBeUndefined();
  });
  it('doubles up to 400 and halves down to 50', () => {
    expect(changeScrollSpeed(100, 'up')).toBe(200);
    expect(changeScrollSpeed(200, 'up')).toBe(400);
    expect(changeScrollSpeed(400, 'up')).toBe(400);
    expect(changeScrollSpeed(100, 'down')).toBe(50);
    expect(changeScrollSpeed(50, 'down')).toBe(50);
  });
});

describe('the shipped credits.json', () => {
  const shipped = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../apps/web/public/credits.json'), 'utf8')) as CreditsJson;
  it('has the core groups, the shipped campaigns and title pictures', () => {
    expect(shipped.groups.length).toBeGreaterThanOrEqual(6);
    expect(shipped.groups.filter((g) => g.id).map((g) => g.id)).toContain('Dead_Water');
    expect(shipped.backgrounds.length).toBeGreaterThan(5);
    const names = creditsLines(shipped, say).filter((l) => l.kind === 'name');
    expect(names.length).toBeGreaterThan(500);
  });
});
