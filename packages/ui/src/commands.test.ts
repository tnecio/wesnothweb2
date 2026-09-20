import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatHotkey, matchesHotkey, type Hotkey } from './commands.js';

/**
 * Phase 15 H0. `matchesHotkey`/`formatHotkey` read `navigator` to decide
 * whether `ctrl` means Control or Command (see `Hotkey`), so the macOS
 * cases stub it; everything else runs on vitest's default jsdom-less
 * environment where `navigator.userAgent` is a plain Node string.
 */
function keyEvent(key: string, modifiers: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}): KeyboardEvent {
  return { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers } as KeyboardEvent;
}

function onMac<T>(run: () => T): T {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'Macintosh' }, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  }
}

afterEach(() => vi.restoreAllMocks());

describe('matchesHotkey', () => {
  it('matches a plain key, ignoring the case the OS reports', () => {
    const next: Hotkey = { key: 'n' };
    expect(matchesHotkey(keyEvent('n'), next)).toBe(true);
    expect(matchesHotkey(keyEvent('N'), next)).toBe(true);
    expect(matchesHotkey(keyEvent('m'), next)).toBe(false);
  });

  it('requires shift to match exactly, separating cycle from cycleback', () => {
    // Upstream: command=cycle key=n, command=cycleback key=n shift=yes.
    const next: Hotkey = { key: 'n' };
    const previous: Hotkey = { key: 'n', shift: true };
    expect(matchesHotkey(keyEvent('n', { shiftKey: true }), next)).toBe(false);
    expect(matchesHotkey(keyEvent('n', { shiftKey: true }), previous)).toBe(true);
    expect(matchesHotkey(keyEvent('n'), previous)).toBe(false);
  });

  it('rejects a modifier the binding does not name', () => {
    // ctrl+r is recruit; the browser's own ctrl+shift+r must not trigger it.
    const recruit: Hotkey = { key: 'r', ctrl: true };
    expect(matchesHotkey(keyEvent('r', { ctrlKey: true }), recruit)).toBe(true);
    expect(matchesHotkey(keyEvent('r', { ctrlKey: true, shiftKey: true }), recruit)).toBe(false);
    expect(matchesHotkey(keyEvent('r', { ctrlKey: true, altKey: true }), recruit)).toBe(false);
    expect(matchesHotkey(keyEvent('r'), recruit)).toBe(false);
  });

  it('distinguishes alt from ctrl (recall is alt+r, recruit is ctrl+r)', () => {
    const recall: Hotkey = { key: 'r', alt: true };
    expect(matchesHotkey(keyEvent('r', { altKey: true }), recall)).toBe(true);
    expect(matchesHotkey(keyEvent('r', { ctrlKey: true }), recall)).toBe(false);
  });

  it('matches space and other named keys', () => {
    expect(matchesHotkey(keyEvent(' ', { ctrlKey: true }), { key: ' ', ctrl: true })).toBe(true);
    expect(matchesHotkey(keyEvent('Escape'), { key: 'Escape' })).toBe(true);
    expect(matchesHotkey(keyEvent('ArrowLeft'), { key: 'ArrowLeft' })).toBe(true);
  });

  it('on macOS, ctrl means Command and plain Control does not fire it', () => {
    onMac(() => {
      const save: Hotkey = { key: 's', ctrl: true };
      expect(matchesHotkey(keyEvent('s', { metaKey: true }), save)).toBe(true);
      expect(matchesHotkey(keyEvent('s', { ctrlKey: true }), save)).toBe(false);
    });
  });

  it('off macOS, the Command key alone does not fire a ctrl binding', () => {
    expect(matchesHotkey(keyEvent('s', { metaKey: true }), { key: 's', ctrl: true })).toBe(false);
  });
});

describe('formatHotkey', () => {
  it('names modifiers and uppercases single characters', () => {
    expect(formatHotkey({ key: 'r', ctrl: true })).toBe('Ctrl+R');
    expect(formatHotkey({ key: 'r', alt: true })).toBe('Alt+R');
    expect(formatHotkey({ key: 'n', shift: true })).toBe('Shift+N');
    expect(formatHotkey({ key: 'l' })).toBe('L');
  });

  it('spells out keys that read badly as raw key values', () => {
    expect(formatHotkey({ key: ' ', ctrl: true })).toBe('Ctrl+Space');
    expect(formatHotkey({ key: 'Escape' })).toBe('Esc');
    expect(formatHotkey({ key: 'ArrowUp' })).toBe('↑');
  });

  it('uses the Mac glyphs on macOS', () => {
    onMac(() => {
      expect(formatHotkey({ key: 's', ctrl: true })).toBe('⌘+S');
      expect(formatHotkey({ key: 'r', alt: true })).toBe('⌥+R');
    });
  });
});
