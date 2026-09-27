# Phase 23 — Mobile UI

Planned 2026-09-27, after the desktop layout settled (Phases 13–15, 21, 22).

## Context

Baseline, measured on a Pixel 7 viewport (412×915 CSS px, touch) before any change:

| Today | Problem |
|---|---|
| Top bar is one `overflow-x: auto` row | In portrait it is cut off after Gold; villages, upkeep, income and time of day are off screen |
| Board status line: scenario name, "(drag or scroll to pan, Ctrl+scroll to zoom)", hovered hex | Takes two lines on a phone, and the advice is about a mouse; touch has no hover |
| Side panel stacks under the board at `max-width: 720px`, `max-height: 42vh` | The minimap and then the unit card compete for that 42vh; End Turn is at the bottom of a scrolled panel |
| Landscape phone (915×412) gets the desktop layout | The 20rem side panel takes a third of the width, and there is no way to hide it |
| Modals are `max-width: 95vw; max-height: 90vh` boxes | Fine on a tablet; on a phone they waste the edges and their buttons are small |
| Input: pointer drag pans, Pixi `pointertap` clicks a hex, right-click opens the context menu, wheel pans, Ctrl+wheel zooms | A tap works, but a single tap moves at once (no chance to check the route), there is no long-press menu and no pinch zoom |
| Story and title screen | The story art is fine; on the title screen the map illustration sits behind the button column |

## Decisions (taken while implementing; the user asked to proceed without questions)

1. **"Compact" layout** = `(max-width: 720px), (max-height: 500px)`: phones in
   either orientation. Tablets and desktops keep the current layout. A
   `compactLayout` store (matchMedia) drives the few things CSS alone can't.
2. **Confirm tap for moves only.** On touch, the first tap on a hex the
   selected unit can reach marks it (the hex is highlighted and the panel says
   "Tap again to move"); a second tap on the same hex moves, and a tap
   anywhere else re-targets. An attack already asks for confirmation in the
   attack dialog, so tapping an enemy opens it directly, as a click does. Mouse
   and keyboard play are unchanged.
3. **Pinch zoom stays on upstream's nine levels**: the pinch picks the level
   nearest to the fingers' scale, anchored between them, and the two-finger
   midpoint pans.
4. **Long-press** (500 ms, under 10 px of movement) opens the same context menu
   as a right-click, and swallows the tap that would follow.
5. **Infobox**: in compact mode a selected or inspected unit's card replaces
   the minimap; deselecting brings the minimap back (the minimap stays
   mounted, only hidden, so it keeps its state). Both the top bar and the
   infobox collapse; the choice persists in the display preferences.
6. **Audio transcode: not done.** It is conditional on real-world mobile tests
   showing a problem, and none has. Music already streams per track on demand.

## Stages

| # | Stage | Checkable outcome |
|---|---|---|
| M1 | Layout: `compactLayout` store; top bar wraps and collapses; board status line hidden in compact mode; infobox as a collapsible bottom panel (portrait) or side panel (landscape) with a sticky header holding the status text and End Turn; unit card replaces the minimap | Pixel 7 portrait and landscape screenshots show every stat and End Turn without scrolling |
| M2 | Dialogs and tap targets: `Modal` fills the screen in compact mode; `(pointer: coarse)` raises buttons, menu entries and minimap buttons to at least 44 px | dialogs fit a 412×915 viewport with no horizontal scroll |
| M3 | Touch input in `GameBoardView`: pinch zoom, two-finger pan, long-press menu, pointer type passed with each hex tap; confirm tap for moves in `GameShell`; tap shows the hex's terrain info | unit tests for the pinch-level maths; the browser checks below |
| M4 | Visuals: title-screen illustration and story art placed and scaled for portrait | screenshots |
| M5 | Milestone script `apps/web/scripts/mobile-playthrough.mjs`: Pixel 7 emulation with touch, `synthetic_keyboard` from story to victory with taps only (counts mouse events: must be zero), plus pinch, long-press, collapse and orientation change without losing state | passes |

## Outcome (2026-09-27)

All five stages delivered as planned, commits `Phase 23 M1`..`M4` plus this one. Two findings changed the
detail:

- The "stretched" story art was upstream's own formula: with `scale_vertically` and `keep_aspect_ratio`, it
  clamps the width to the window but keeps the full height, a 2.9x squeeze on a phone held upright. The
  fix is a threshold (1.25x), so desktop layouts stay exactly upstream's.
- A long press must also stop Android's native `contextmenu` and the finger's lifting `click` from
  reaching the context menu's "close when something outside is clicked".

The milestone passes. `dialogue-playthrough.mjs` fails one Dead Water 5 check; whether Phase 23 caused
it is still open (the "fails on the pre-phase source too" check was invalid -- see PROGRESS).
