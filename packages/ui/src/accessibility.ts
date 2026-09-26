/**
 * The player's accessibility preferences (Phase 20), kept per browser like the audio settings:
 *
 *  - `fontScale`: upstream's `font_scaling` preference, 80-150 percent (`preferences::font_scaled`). It
 *    scales the root font size, so everything the UI sizes in `rem` follows, and `--font-scale` for
 *    the few places that size text in pixels (the story and dialogue overlays, laid out to
 *    upstream's pixel metrics).
 *  - `orbColors`: upstream's `unmoved_orb_color`/`partial_orb_color`/`moved_orb_color` preferences,
 *    which are team-colour ids. The orb on a unit says whether it can still act; its default colours
 *    (green, orange, red) are the classic red-green trap, so they are settings.
 *
 * Plain TypeScript with a `createSubscriber` bridge, like `i18n/locale.ts`, so it runs under node.
 */

import { createSubscriber } from 'svelte/reactivity';

export type OrbStatus = 'unmoved' | 'partial' | 'moved';

export interface AccessibilitySettings {
  /** 80-150 (percent). */
  fontScale: number;
  /** Team-colour id per orb status (see `apps/web/public/team-colors.json`). */
  orbColors: Record<OrbStatus, string>;
}

export const FONT_SCALE_MIN = 80;
export const FONT_SCALE_MAX = 150;
export const FONT_SCALE_STEP = 5;

/** The colour ids upstream's defaults use (`game_config`: green, orange, red), matching the renderer's own. */
export const DEFAULT_ORB_COLORS: Readonly<Record<OrbStatus, string>> = {
  unmoved: 'brightgreen',
  partial: 'brightorange',
  moved: 'red',
};

export const DEFAULT_ACCESSIBILITY: Readonly<AccessibilitySettings> = {
  fontScale: 100,
  orbColors: DEFAULT_ORB_COLORS,
};

export const ACCESSIBILITY_KEY = 'wesnothweb2.accessibility';

export function clampFontScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ACCESSIBILITY.fontScale;
  const stepped = Math.round(value / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, stepped));
}

/** Reads what `saveAccessibility` wrote; anything missing or malformed takes its default. */
export function parseAccessibility(raw: string | null | undefined, knownColors?: ReadonlySet<string>): AccessibilitySettings {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: the defaults.
  }
  const saved = (data['orbColors'] && typeof data['orbColors'] === 'object' ? data['orbColors'] : {}) as Record<string, unknown>;
  const color = (status: OrbStatus): string => {
    const v = saved[status];
    return typeof v === 'string' && /^[a-z0-9_]+$/.test(v) && (!knownColors || knownColors.has(v)) ? v : DEFAULT_ORB_COLORS[status];
  };
  return {
    fontScale: clampFontScale(data['fontScale']),
    orbColors: { unmoved: color('unmoved'), partial: color('partial'), moved: color('moved') },
  };
}

export interface AccessibilityHost {
  load(): string | null;
  save(raw: string): void;
  /** Applies the font scale to the page (`--font-scale` and the root font size). */
  applyFontScale(scale: number): void;
  /** Hands the orb colours to whatever draws the orbs. */
  applyOrbColors(colors: Readonly<Record<OrbStatus, string>>): void;
}

function browserHost(): AccessibilityHost {
  return {
    load: () => {
      try {
        return localStorage.getItem(ACCESSIBILITY_KEY);
      } catch {
        return null;
      }
    },
    save: (raw) => {
      try {
        localStorage.setItem(ACCESSIBILITY_KEY, raw);
      } catch {
        /* private window: the choice just is not remembered */
      }
    },
    applyFontScale: (scale) => {
      if (typeof document === 'undefined') return;
      const root = document.documentElement;
      root.style.fontSize = `${scale}%`;
      root.style.setProperty('--font-scale', String(scale / 100));
    },
    applyOrbColors: () => undefined,
  };
}

export class AccessibilityManager {
  private settings: AccessibilitySettings = { ...DEFAULT_ACCESSIBILITY, orbColors: { ...DEFAULT_ORB_COLORS } };
  private readonly listeners = new Set<() => void>();
  private readonly subscribe = createSubscriber((update) => {
    this.listeners.add(update);
    return () => this.listeners.delete(update);
  });

  constructor(private host: AccessibilityHost) {}

  setHost(host: AccessibilityHost): void {
    this.host = host;
  }

  /** The current settings. Reactive. */
  get current(): Readonly<AccessibilitySettings> {
    this.subscribe();
    return this.settings;
  }

  /** Reads the saved settings and applies them. `knownColors` drops a saved colour id the game does not define. */
  init(knownColors?: ReadonlySet<string>): void {
    this.settings = parseAccessibility(this.host.load(), knownColors);
    this.apply();
  }

  /** Changes some settings, applies and remembers them. */
  update(patch: { fontScale?: number; orbColors?: Partial<Record<OrbStatus, string>> }): void {
    this.settings = {
      fontScale: patch.fontScale === undefined ? this.settings.fontScale : clampFontScale(patch.fontScale),
      orbColors: { ...this.settings.orbColors, ...patch.orbColors },
    };
    this.host.save(JSON.stringify(this.settings));
    this.apply();
  }

  private apply(): void {
    this.host.applyFontScale(this.settings.fontScale);
    this.host.applyOrbColors(this.settings.orbColors);
    for (const update of [...this.listeners]) update();
  }
}

export const accessibility = new AccessibilityManager(browserHost());
