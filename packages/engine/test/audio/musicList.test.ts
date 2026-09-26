import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { MusicList, applyMusicAction } from '../../src/audio/musicList.js';

/**
 * `MusicList` tests -- expectations follow `sound.cpp`'s `play_music_config`,
 * `commit_music_changes`, `choose_track`/`track_ok` and `wml-tags.lua`'s `[music]`.
 */

function scripted(...values: number[]): (max: number) => number {
  let i = 0;
  return (max) => Math.min(values[i++ % values.length]!, max);
}

/** A small deterministic generator, so the choice loop always terminates. */
function lcg(seed: number): (max: number) => number {
  let x = seed >>> 0;
  return (max) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return Math.floor((x / 0x100000000) * (max + 1));
  };
}

function cfg(attrs: Record<string, string | number | boolean>): WmlConfig {
  const c = new WmlConfig();
  for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
  return c;
}

function names(list: MusicList): string[] {
  return Array.from({ length: list.length }, (_, i) => list.track(i)!.id);
}

describe('MusicList.playConfig', () => {
  it('replaces the list unless append=yes, and lets the current track finish', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.commit();
    expect(list.current?.id).toBe('a.ogg');
    list.playConfig(cfg({ name: 'b.ogg' }), false);
    expect(names(list)).toEqual(['b.ogg']);
    // The old track is not on the list any more, but plays to its end.
    expect(list.current?.once).toBe(true);
    expect(list.request?.track.id).toBe('a.ogg');
  });

  it('appends, inserting at an index and keeping the current index pointing at the same track', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.playConfig(cfg({ name: 'b.ogg', append: true }), true);
    list.playConfig(cfg({ name: 'c.ogg', append: true, immediate: true }), true);
    expect(list.current?.id).toBe('c.ogg');
    expect(list.currentTrackIndex).toBe(2);
    list.playConfig(cfg({ name: 'x.ogg', append: true }), true, 0);
    expect(names(list)).toEqual(['x.ogg', 'a.ogg', 'b.ogg', 'c.ogg']);
    expect(list.currentTrackIndex).toBe(3);
    expect(list.track(list.currentTrackIndex!)?.id).toBe('c.ogg');
  });

  it('skips a duplicate name but still honours immediate=yes for the existing entry', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.playConfig(cfg({ name: 'b.ogg', append: true }), true);
    list.playConfig(cfg({ name: 'a.ogg', append: true, immediate: true }), true);
    expect(names(list)).toEqual(['a.ogg', 'b.ogg']);
    expect(list.current?.id).toBe('a.ogg');
    list.playConfig(cfg({ name: 'b.ogg', append: true, immediate: true }), true);
    expect(list.current?.id).toBe('b.ogg');
    expect(list.currentTrackIndex).toBe(1);
  });

  it('play_once plays now without touching the list', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.playConfig(cfg({ name: 'stinger.ogg', play_once: true }), true);
    expect(names(list)).toEqual(['a.ogg']);
    expect(list.current?.id).toBe('stinger.ogg');
    expect(list.currentTrackIndex).toBeUndefined();
  });

  it('refuses a track whose file does not exist, or with no name', () => {
    const list = new MusicList({ random: scripted(0), exists: (id) => id === 'a.ogg' });
    list.playConfig(cfg({ name: 'missing.ogg' }), true);
    list.playConfig(cfg({ name: '' }), true);
    expect(list.length).toBe(0);
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    expect(list.length).toBe(1);
  });

  it('fades the previous track out by its ms_after and the new one in by its ms_before', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg', ms_after: 2000, immediate: true }), true);
    list.playConfig(cfg({ name: 'b.ogg', ms_before: 500, append: true, immediate: true }), true);
    expect(list.request).toMatchObject({ fadeOutMs: 2000, fadeInMs: 500 });
    expect(list.request?.track.id).toBe('b.ogg');
  });
});

describe('MusicList.commit', () => {
  it('starts the list when nothing plays, and forgets what was played', () => {
    const list = new MusicList({ random: scripted(1) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.playConfig(cfg({ name: 'b.ogg', append: true }), true);
    list.commit();
    expect(list.current?.id).toBe('b.ogg');
    expect(list.request?.seq).toBe(1);
  });

  it('keeps a play-once or still-listed current track', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.commit();
    const seq = list.request!.seq;
    list.commit();
    expect(list.request!.seq).toBe(seq);
    list.playOnce('stinger.ogg');
    const seq2 = list.request!.seq;
    list.playConfig(cfg({ name: 'z.ogg' }), true);
    list.commit();
    expect(list.request!.seq).toBe(seq2);
  });

  it('switches when the current track is no longer on the list', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.commit();
    list.playConfig(cfg({ name: 'b.ogg' }), true);
    list.commit();
    expect(list.current?.id).toBe('b.ogg');
  });

  it('does nothing with an empty list', () => {
    const list = new MusicList({ random: scripted(0) });
    list.commit();
    expect(list.request).toBeNull();
  });
});

describe('MusicList track choice', () => {
  function played(list: MusicList, count: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      list.trackEnded();
      out.push(list.current!.id);
    }
    return out;
  }

  it('never repeats the current track back to back when there is a choice', () => {
    const list = new MusicList({ random: lcg(7) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.playConfig(cfg({ name: 'b.ogg', append: true }), true);
    list.commit();
    const seq = played(list, 50);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  it('with more than three tracks, does not play the one before the previous', () => {
    const list = new MusicList({ random: lcg(42) });
    for (const [i, n] of ['a', 'b', 'c', 'd', 'e'].entries()) list.playConfig(cfg({ name: `${n}.ogg`, append: i > 0 }), true);
    list.commit();
    const seq = [list.current!.id, ...played(list, 60)];
    for (let i = 2; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 2]);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  it('with shuffle=no on the entry at the current index, keeps that entry (choose_track never advances the index)', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    for (const n of ['b', 'c']) list.playConfig(cfg({ name: `${n}.ogg`, append: true }), true);
    for (let i = 0; i < list.length; i++) list.track(i)!.shuffle = false;
    list.playConfig(cfg({ name: 'b.ogg', append: true, immediate: true }), true);
    expect(list.current?.id).toBe('b.ogg');
    expect(played(list, 3)).toEqual(['b.ogg', 'b.ogg', 'b.ogg']);
  });

  it('a track following another is not faded', () => {
    const list = new MusicList({ random: lcg(3) });
    list.playConfig(cfg({ name: 'a.ogg', ms_before: 900, ms_after: 900 }), true);
    list.playConfig(cfg({ name: 'b.ogg', ms_before: 900, ms_after: 900, append: true }), true);
    list.commit();
    list.trackEnded();
    expect(list.request).toMatchObject({ fadeOutMs: 0, fadeInMs: 0 });
  });

  it('trackEnded on an empty list starts nothing', () => {
    const list = new MusicList({ random: scripted(0) });
    list.trackEnded();
    expect(list.request).toBeNull();
  });

  it('next() moves on, fading the previous track out', () => {
    const list = new MusicList({ random: scripted(0, 1) });
    list.playConfig(cfg({ name: 'a.ogg', ms_after: 300 }), true);
    list.playConfig(cfg({ name: 'b.ogg', append: true }), true);
    list.commit();
    list.next();
    expect(list.current?.id).toBe('b.ogg');
    expect(list.request?.fadeOutMs).toBe(300);
  });
});

describe('MusicList.write', () => {
  it('writes the first entry as replacing and the rest as appended, and round-trips through playConfig', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg', ms_before: 10, ms_after: 20 }), true);
    list.playConfig(cfg({ name: 'b.ogg', append: true }), true);
    list.track(1)!.shuffle = false;
    const written = list.write();
    expect(written.map((m) => m.getBoolean('append', false))).toEqual([false, true]);
    expect(written[0]!.getNumber('ms_before')).toBe(10);
    expect(written[1]!.getBoolean('shuffle', true)).toBe(false);
    const again = new MusicList({ random: scripted(0) });
    for (const m of written) again.playConfig(m, true);
    expect(again.write().map((m) => m.toJSON())).toEqual(written.map((m) => m.toJSON()));
  });
});

describe('applyMusicAction ([music])', () => {
  it('replaces the list, changes nothing until committed, and applies shuffle= and title=', () => {
    const list = new MusicList({ random: scripted(0) });
    list.playConfig(cfg({ name: 'a.ogg' }), true);
    list.commit();
    applyMusicAction(list, cfg({ name: 'b.ogg', shuffle: false, title: 'Bee' }));
    expect(names(list)).toEqual(['b.ogg']);
    expect(list.track(0)).toMatchObject({ shuffle: false, title: 'Bee' });
    // The Lua adds with append=yes, so the current track is not marked play-once: it plays on until
    // it ends or the list is committed.
    expect(list.current?.id).toBe('a.ogg');
    expect(list.current?.once).toBe(false);
  });

  it('append=yes adds to the list', () => {
    const list = new MusicList({ random: scripted(0) });
    applyMusicAction(list, cfg({ name: 'a.ogg' }));
    applyMusicAction(list, cfg({ name: 'b.ogg', append: true }));
    expect(names(list)).toEqual(['a.ogg', 'b.ogg']);
  });

  it('immediate=yes marks the current track play-once, clears, and switches now', () => {
    const list = new MusicList({ random: scripted(0) });
    applyMusicAction(list, cfg({ name: 'a.ogg' }));
    list.commit();
    applyMusicAction(list, cfg({ name: 'b.ogg', immediate: true, ms_before: 400 }));
    expect(list.current?.id).toBe('b.ogg');
    expect(list.request).toMatchObject({ fadeInMs: 400 });
  });

  it('play_once=yes plays the named track without changing the list', () => {
    const list = new MusicList({ random: scripted(0) });
    applyMusicAction(list, cfg({ name: 'a.ogg' }));
    applyMusicAction(list, cfg({ name: 'sting.ogg', play_once: true }));
    expect(names(list)).toEqual(['a.ogg']);
    expect(list.current?.id).toBe('sting.ogg');
  });

  it('does not retitle a track it could not add', () => {
    const list = new MusicList({ random: scripted(0) });
    applyMusicAction(list, cfg({ name: 'a.ogg', title: 'A' }));
    applyMusicAction(list, cfg({ name: 'a.ogg', append: true, title: 'Other' }));
    expect(list.track(0)?.title).toBe('A');
  });
});
