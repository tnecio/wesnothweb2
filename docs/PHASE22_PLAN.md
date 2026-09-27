# Phase 22 — Advanced map rendering: minimap & camera

Planned 2026-09-27. Remainder of the old Phase 16 after labels/items (Phase 18)
and camera scripting (Phase 17) moved out.

## Context

The board can be panned (drag) and zoomed (wheel, `=`/`-`/`0`), and the
scripted camera tags work, but everything about the camera is ad hoc:

| Today (`packages/ui/src/GameBoardView.svelte`) | Upstream |
|---|---|
| Zoom is continuous, `0.3`–`3` | Nine discrete hex sizes, `16, 24, 36, 52, 72, 100, 144, 216, 288` px (`data/game_config.cfg:42`; 72 = 1:1), stepped by index (`display::set_zoom`) |
| No bounds: the board can be dragged off screen entirely | `display::bounds_check_position` keeps the map in view; a map smaller than the viewport is centred |
| Every camera move is an instant jump (`centerOnHex`, `scrollToHexIfOffscreen`) | `display::scroll_to_xy` animates with acceleration/deceleration (0.3 s / 0.4 s, top speed `scroll_speed × 60` px/s, default 50), warps under turbo or speed 100 |
| AI moves and attacks play wherever the camera happens to be; off-screen they are invisible | `scroll_to_action` (default on): the camera brings each action on screen before it animates |
| No edge-of-screen panning | `mouse_scrolling` (default on), 10 px threshold, speed from `scroll_speed` (`controller_base.cpp:282-335`) |
| Mouse wheel zooms | Mouse wheel **pans** (`mouse_handler_base::mouse_wheel`); zoom is keyboard/buttons only |
| No minimap | Top-right minimap (`minimap.cpp`), with five toggle buttons |
| No grid, no enemy-reach overlay | `togglegrid` (Ctrl+G), `showenemymoves` (Ctrl+V), `bestenemymoves` (Ctrl+B) |

What already exists and is reused:

- Every `[terrain_type]`, including `symbol_image`, ships in each snapshot
  (`terrainTypeConfigs`, 284 entries). The minimap tiles are
  `terrain/<symbol_image>.png`, plus `terrain/minimap-fog.png` and
  `terrain/minimap-highlight.png` — all already served under `/game-images`.
- Team colour ranges (`team-colors.json`) give `team::get_minimap_color`
  (the range's `rep`), and `unitOverlays.ts` already has the orb colours.
- Fog/shroud per viewing side (Phase 11), village owners, unit visibility
  (`hidden`, invisibility) are all on the session already.
- `GameBoardView` already exposes `centerOnHex`/`scrollToHexIfOffscreen`/
  `zoomBy`/`zoomTo`/`scrollByPixels` and the `[lock_view]` flag; every caller
  goes through them, so the camera can be rebuilt behind that API.

## Stages

Each stage is its own commit, ends with every suite green (`npm test
--workspaces`, `npm run typecheck --workspaces`, `svelte-check`) and a dated
`docs/PROGRESS.md` entry.

### S1 — A camera model (pure, tested)

New `packages/renderer/src/camera.ts`, no Pixi, no DOM:

- `ZOOM_LEVELS` from upstream, `zoomIndexFor(scale)` (`get_zoom_levels_index`:
  nearest level), `stepZoom(index, ±1)`.
- `clampView(view, mapPixelSize, viewportSize)` — port of
  `bounds_check_position`: at most half a hex of border past the map edge,
  and centred on an axis where the map is smaller than the viewport.
- `zoomAbout(view, newScale, anchor)` — the "keep this screen point fixed"
  arithmetic currently duplicated in the wheel handler and `zoomBy`.
- `scrollPlan(from, to, speed)` → a `step(dt)` function reproducing
  `scroll_to_xy`'s accelerate / cruise / decelerate profile exactly (same
  constants, same 200 ms `dt` cap), returning the position and whether it's done.

`GameBoardView` routes every stage mutation through one `applyView()` that
clamps. Zoom hotkeys and `[zoom]` step through the discrete levels; `[zoom]
factor=` snaps as `set_zoom` does. `zoomDefault` goes back to level 72.

Tests: `packages/renderer/test/camera.test.ts` — level snapping and stepping
at both ends, clamping for maps larger/smaller than the viewport at several
zooms, zoom-about-point keeps the anchor fixed, and the scroll profile
(reaches the target exactly, never overshoots, never exceeds top speed, total
time for a known distance matches a hand-computed value).

### S2 — Smooth scrolling, and following the action

- `centerOnHex`/`scrollToHexIfOffscreen` become `scrollToHex(x, y, mode)`
  with upstream's `SCROLL` / `WARP` / `ONSCREEN` / `ONSCREEN_WARP`, returning
  a promise that resolves when the camera arrives, driven by the Pixi ticker.
  Warps when `prefers-reduced-motion` (Phase 20's setting), turbo, or scroll
  speed 100 — as upstream.
- Callers pick upstream's mode: next unit / leader → `SCROLL`; message
  speaker → `ONSCREEN`; `[scroll_to] immediate=yes` → `WARP`; keyboard cursor
  → `ONSCREEN`. Cutscene beats await arrival, so a `[message]` no longer opens
  before its speaker is on screen.
- **Follow unit actions** (`scroll_to_action`): in `playAiAnimations` and
  replay playback, before a move animates, scroll so its path is on screen
  (`unit_display::move_unit` → `scroll_to_tiles(path, ONSCREEN)`); likewise for
  attacks (both combatants) and recruits. Skipped when the viewing side can't
  see the hexes (fog), as upstream's `check_fogged`.
- Wheel pans (`scroll_speed` per notch, Alt swaps axes as upstream);
  Ctrl+wheel zooms one level about the pointer, with small trackpad deltas
  accumulated so one pinch is not a dozen steps.

### S3 — Edge-of-screen panning

Pointer within 10 px of the **window** edge (upstream measures the game
canvas, which is the whole window there) pans at `scroll_speed × 0.036`
px/ms, clamped by S1. Off while a modal is open, while `[lock_view]` holds,
and when the pointer has left the page. Preferences gain a small "General"
section holding `scroll_speed` (1–100, default 50), `mouse_scrolling`
(default on) and `scroll_to_action` (default on), persisted beside the
existing display/audio settings — Phase 24 later folds them into its full
General tab.

### S4 — Minimap

- Pure `packages/renderer/src/minimap.ts`: `buildMinimap(board, viewingSide,
  options)` → a draw list, porting `prep_minimap_for_rendering` line for line:
  the scale rule (24/16/8 px per hex by map size, 4 when terrain coding is
  off), `get_dst_rect`'s half-hex stagger, shrouded hexes as `VOID_TERRAIN`,
  fog overlay, reach highlight, villages hidden under fog/shroud and
  coloured by owner (team colour with movement coding, else own/ally/enemy
  orb colours), units skipped when fogged, hidden, or invisible enemies.
  Colour-coding mode (`terrain_coding` off) uses the terrain-id colour ranges
  as upstream does.
- `packages/ui/src/Minimap.svelte`: draws that list onto a 2D `<canvas>`
  (nearest-neighbour, aspect-preserving and centred as upstream's returned
  lambda), plus the viewport rectangle from `GameBoardView`'s live view.
  Click or drag recentres the camera (warp while dragging, as upstream).
  Redraws on the same state changes that already re-render the board (units,
  village owners, fog, reach), throttled to one per frame.
- Placement: top of the right-hand panel, where the default theme has it,
  with upstream's five toggle buttons (draw terrain, terrain coding, units,
  unit coding, villages) persisted as preferences.
- `aria-label` and keyboard: the minimap is a button-like region; Enter on
  it is not meaningful, so it is `aria-hidden` for screen readers, which get
  the existing hex-cursor announcements instead.

Tests (`packages/renderer/test/minimap.test.ts`, node): the scale rule; a
fogged enemy unit and a fogged village are absent while a visible one is
present in the right colour; a shrouded hex draws as void; own/ally/enemy
village colours with and without movement coding; an invisible enemy is
skipped; the rectangle for hex (x, y) matches `get_dst_rect`.

### S5 — Grid and enemy reach

- **Grid** (Ctrl+G, `togglegrid`, persisted): upstream draws
  `terrain/grid-top.png` and `grid-bottom.png` over every hex; a single
  cached layer in `SnapshotBoard`.
- **Show enemy moves** (Ctrl+V) and **best possible enemy moves** (Ctrl+B,
  `ignore_units`): new `GameSession.enemyReach(ignoreUnits)` — every
  non-fogged, visible, non-incapacitated enemy of the viewing side, with
  movement reset to full, pathfound with the viewing team's vision, union of
  destinations (`menu_handler::show_enemy_moves`). Drawn with the existing
  reach highlight, and fed into the minimap's highlight overlay. Cleared by
  the next selection or hovered-hex change, as upstream.
- Both added to the command registry (menu entries under View where upstream
  has them, hotkeys as above) so Phase 24's rebinding covers them.

Tests: `gameSession.test.ts` — enemy reach on a real scenario equals the
union of each enemy's own reach; `ignoreUnits` reaches through a blocking
unit that the normal mode stops at; fogged enemies contribute nothing.

### S6 — Milestone and docs

`apps/web/scripts/minimap-camera-playthrough.mjs`:

1. The minimap draws Dead Water 1 with the player's villages in the player's
   colour; capture a village and it changes colour without a reload.
2. Under Under the Burning Suns' fog, an enemy unit out of vision is not on
   the minimap; move into vision and it appears.
3. Clicking a minimap point recentres the board on that hex
   (`viewCenterHex()` within one hex); dragging the minimap pans.
4. Dragging the board far past the map edge is clamped; zoom hotkeys walk
   exactly the nine upstream levels.
5. Next-unit scrolls smoothly (intermediate frames observed) and warps
   under reduced motion; an off-screen AI move is brought on screen before it
   animates.
6. Ctrl+G toggles the grid; Ctrl+V shows enemy reach.

Plus a screenshot next to the real 1.16.9 binary's (`Xvfb` recipe) for the
minimap on the same scenario. `docs/IMPLEMENTATION_PLAN.md` Phase 22 marked
delivered; `docs/PROGRESS.md` entries per stage.

## Files

| File | Change |
|---|---|
| `packages/renderer/src/camera.ts` | **new** — zoom levels, clamping, scroll profile (S1) |
| `packages/renderer/src/minimap.ts` | **new** — minimap draw list (S4) |
| `packages/renderer/src/SnapshotBoard.ts` | grid layer (S5) |
| `packages/ui/src/GameBoardView.svelte` | camera through `camera.ts`, smooth scroll, edge pan, wheel, view-change events (S1–S3) |
| `packages/ui/src/Minimap.svelte` | **new** (S4) |
| `packages/ui/src/SidePanel.svelte` | hosts the minimap (S4) |
| `packages/ui/src/GameShell.svelte` | scroll modes per caller, follow-action in AI/replay playback, grid/enemy-reach commands (S2, S5) |
| `packages/ui/src/gameSession.ts` | `enemyReach` (S5) |
| `packages/ui/src/PreferencesDialog.svelte` + a small settings module | scroll speed, mouse scrolling, follow actions, grid, minimap toggles (S3–S5) |
| `apps/web/scripts/minimap-camera-playthrough.mjs` | **new** milestone (S6) |

## Decisions (user, 2026-09-27)

1. **Mouse wheel pans, as upstream; Ctrl+wheel zooms** through the levels
   (trackpad pinch arrives as Ctrl+wheel, so it zooms too). Replaces today's
   wheel zoom (S2).
2. **Arrow keys stay on Phase 15's hex cursor**, which already brings the view
   with it; no separate pan keys.
3. **Terrain-help data moves to Phase 24**, next to the help browser that
   uses it.

## Risks

| Risk | Mitigation |
|---|---|
| Discrete zoom steps feel coarser than today's smooth wheel zoom | It is upstream's behaviour and keeps sprites at the sizes the art was drawn for; the steps are close together (≈1.4×) |
| Awaiting scroll arrival in cutscene beats slows scripted scenes | Upstream blocks the same way; reduced motion and turbo warp |
| Minimap redraws on every state change cost frames during AI turns | Draw list is cheap (hexes × 1 blit); throttled to one redraw per animation frame, and the map-sized base terrain is cached until terrain changes |
| Follow-action scrolling fights the player's own panning mid-AI-turn | Upstream does the same; `scroll_to_action` off disables it |
| Edge panning triggers while reaching for browser chrome | Only while the pointer is inside the page and no modal is open; preference to turn off |
