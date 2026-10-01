# Help browser: reference screenshots

Captured 2026-09-30 from the real game (the installed Wesnoth 1.16.9, run with `--debug` so that every unit
is listed) under Xvfb at 1366×800. They are the visual target for the port's help browser (Phase 24).

| File | What it shows |
|---|---|
| `contents.jpg` | The help as it opens, on Introduction. The tree on the left has book icons for sections and a page icon for topics. The page has a bold title, the logo centred, and body text. |
| `units-section.jpg` | A section's own page (`..units`): the intro text, then the bullet list of links to its subsections (the `contents:generated` generator). |
| `race-merfolk.jpg` | A race page, with the tree unfolded two levels. It shows the description, "Alignment: lawful" and the list "Units of this race". |
| `unit-merman-fighter.jpg`, `-2`, `-3` | A unit page, scrolled from top to bottom. It has the level, the sprite at 2×, and the portrait flipped and floated right. Then come the Advances to / Race / Traits link lines and the HP / Moves / Cost / Alignment / Required XP line. Last come the description and the Attacks, Resistances and Terrain Modifiers tables. The Terrain Modifiers table is empty here because this profile had met no terrains; the port lists every terrain. |
| `gameplay.jpg` | A text page: italics, bold, inline links, an image floated right, and a header followed by a list of links. |
| `terrains-section.jpg` | The Terrains section: headers and rows of hex terrain images. |

## What 1.19 changes

The port ships 1.19 data, and 1.19's help browser (`data/gui/themes/default/dialogs/help_browser.cfg`,
`src/gui/dialogs/help_browser.cpp`) differs from these 1.16 screenshots:

- The window is a fixed 1350×800, centred.
- A top bar replaces the bottom-left back arrow. It holds the topic title, a **Show Topics** toggle that
  hides the tree, **back** and **next** arrows, and a search box ("Search help topic names") that filters
  the tree.
- The page is a `rich_label`. Tables are `<table><row bgcolor=table_header|table_row1|table_row2><col>`, and
  images can be inline or floated.

The theme is otherwise the same: a dark navy panel with a gold border, and yellow links.
