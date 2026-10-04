/**
 * Phase 28c: a custom dialog a campaign's Lua shows with `gui.show_dialog`
 * (`src/scripting/lua_gui2.cpp`'s `show_dialog`), as data. Upstream builds a
 * real GUI2 window from the `[resolution]` WML; here the WML becomes a plain,
 * serialisable widget tree (`GuiNode`) that the Lua runtime changes the way
 * the campaign's preshow/callbacks ask (`label`, `visible`, `selected_index`)
 * and a display draws. A dialog blocks its event like a `[message]` does
 * (`GuiDialogInteraction`).
 *
 * Widgets understood (what the bundled campaigns' dialogs use): `[grid]`
 * with `[row]`/`[column]` (`border=`, `border_size=`, `horizontal_alignment=`),
 * `[label]` (`use_markup=`, `definition=title`, `text_alignment=`),
 * `[image]`, `[button]` (`return_value=`, `return_value_id=`), `[spacer]`,
 * `[listbox]`/`[horizontal_listbox]` built from `[list_definition]` and
 * `[list_data]`, and `[toggle_panel]`/`[panel]` as plain containers. Any
 * other widget is kept as `unknown` so the display can show that something
 * is missing rather than silently dropping it.
 */

import { TString } from '../i18n/tstring.js';
import type { TStringJson } from '../i18n/tstring.js';
import { WmlConfig } from '../wml/config.js';

/** Text on a widget: translatable when the WML wrote `_ "..."`. */
export type GuiText = string | TStringJson;

export interface GuiCell {
  readonly border: readonly ('top' | 'bottom' | 'left' | 'right')[];
  readonly borderSize: number;
  readonly horizontalAlignment: 'left' | 'center' | 'right' | 'stretch';
  readonly verticalAlignment: 'top' | 'center' | 'bottom' | 'stretch';
  readonly widget: GuiNode;
}

interface GuiBase {
  readonly id: string;
  /** `visible=` / Lua `widget.visible`: `hidden` keeps its space, `invisible` takes none (GUI2's `visibility`). */
  visibility: 'visible' | 'hidden' | 'invisible';
}

export type GuiNode =
  | (GuiBase & { readonly type: 'grid'; readonly rows: GuiCell[][] })
  | (GuiBase & { readonly type: 'label'; label: GuiText; markup: boolean; readonly rich: boolean; readonly title: boolean; readonly textAlignment: string })
  | (GuiBase & { readonly type: 'image'; label: string })
  /**
   * `returnValue`: what clicking it closes the dialog with -- `return_value=`, else `ok`/`cancel` named by
   * `return_value_id=` or the button's own id (`get_retval`), else 0, which leaves the dialog open (only its
   * `on_button_click` runs). `enabled`: Lua's `widget.enabled` (a disabled button cannot be clicked).
   */
  | (GuiBase & { readonly type: 'button'; label: GuiText; readonly returnValue: number; markup: boolean; enabled: boolean })
  /** `[menu_button]`: a drop-down of its `[option]` labels; `selectedIndex` is 1-based, as Lua's `selected_index`. */
  | (GuiBase & { readonly type: 'menu_button'; readonly options: GuiText[]; selectedIndex: number; markup: boolean; enabled: boolean })
  | (GuiBase & { readonly type: 'spacer'; readonly width: number; readonly height: number })
  | (GuiBase & {
      readonly type: 'listbox';
      readonly horizontal: boolean;
      /** One instantiated `[list_definition]` row per `[list_data]` row. */
      readonly rows: GuiNode[];
      /** 1-based, as Lua's `selected_index`; 0 when nothing is selected (`has_minimum=no`). */
      selectedIndex: number;
    })
  | (GuiBase & { readonly type: 'panel'; readonly child: GuiNode })
  | (GuiBase & { readonly type: 'unknown'; readonly tag: string });

/** A dialog ready to show: the widget tree, and whether it has been asked to close. */
export interface GuiDialogSpec {
  root: GuiNode;
}

/** `gui.show_dialog` waiting for the player. */
export interface GuiDialogInteraction {
  readonly kind: 'guiDialog';
  readonly dialog: GuiDialogSpec;
}

/** GUI2's `retval`: a button without `return_value=` closes with OK (-1); Escape is CANCEL (-2); `close()` leaves NONE (0). */
export const GUI_RETVAL = { NONE: 0, OK: -1, CANCEL: -2 } as const;

/** `return_value_id=` names (`gui/core/window_builder.cpp`'s `get_retval`). */
const RETVAL_IDS: Record<string, number> = { ok: GUI_RETVAL.OK, cancel: GUI_RETVAL.CANCEL, quit: GUI_RETVAL.CANCEL };

const WIDGET_TAGS = new Set(['grid', 'label', 'image', 'button', 'spacer', 'listbox', 'horizontal_listbox', 'toggle_panel', 'panel', 'scroll_label', 'toggle_button', 'menu_button', 'rich_label']);

function text(cfg: WmlConfig, key: string): GuiText {
  const raw = cfg.getRaw(key);
  if (raw instanceof TString) return raw.translatable ? raw.toJSON() : raw.str();
  return raw === undefined ? '' : String(raw);
}

function visibilityOf(cfg: WmlConfig): GuiBase['visibility'] {
  const v = cfg.getString('visible', 'visible');
  if (v === 'false' || v === 'no' || v === 'hidden') return 'hidden';
  if (v === 'invisible') return 'invisible';
  return 'visible';
}

function cellOf(column: WmlConfig, overrides?: Map<string, WmlConfig>): GuiCell {
  const border = column.getString('border', '');
  const all = border.split(',').map((s) => s.trim());
  const sides = (['top', 'bottom', 'left', 'right'] as const).filter((s) => all.includes(s) || all.includes('all'));
  const widgetEntry = column.allChildren().find((e) => WIDGET_TAGS.has(e.tag)) ?? column.allChildren()[0];
  const align = (key: string): 'left' | 'center' | 'right' | 'stretch' | 'top' | 'bottom' => {
    const v = column.getString(key, key === 'horizontal_alignment' ? 'center' : 'center');
    return (['left', 'center', 'right', 'stretch', 'top', 'bottom'].includes(v) ? v : 'center') as ReturnType<typeof align>;
  };
  return {
    border: sides,
    borderSize: column.getNumber('border_size', 0),
    horizontalAlignment: align('horizontal_alignment') as GuiCell['horizontalAlignment'],
    verticalAlignment: align('vertical_alignment') as GuiCell['verticalAlignment'],
    widget: widgetEntry ? nodeOf(widgetEntry.tag, widgetEntry.config, overrides) : { type: 'spacer', id: '', visibility: 'visible', width: 0, height: 0 },
  };
}

function gridOf(cfg: WmlConfig, overrides?: Map<string, WmlConfig>): GuiNode {
  return {
    type: 'grid',
    id: cfg.getString('id', ''),
    visibility: visibilityOf(cfg),
    rows: cfg.children('row').map((row) => row.children('column').map((column) => cellOf(column, overrides))),
  };
}

/**
 * One widget. `overrides` are a `[list_data]` row's `[widget] id=` settings, applied to the widgets of the
 * `[list_definition]` row being instantiated (`listbox::add_row`).
 */
function nodeOf(tag: string, source: WmlConfig, overrides?: Map<string, WmlConfig>): GuiNode {
  const id = source.getString('id', '');
  const over = id ? overrides?.get(id) : undefined;
  const cfg = over ? merged(source, over) : source;
  const base = { id, visibility: visibilityOf(cfg) };
  switch (tag) {
    case 'grid':
      return gridOf(cfg, overrides);
    case 'label':
    case 'scroll_label':
    case 'rich_label':
      return {
        ...base,
        type: 'label',
        label: text(cfg, 'label'),
        // A rich label always reads markup (`rich_label` parses its text as help markup).
        markup: tag === 'rich_label' || cfg.getBoolean('use_markup', false),
        rich: tag === 'rich_label',
        title: cfg.getString('definition', '') === 'title',
        textAlignment: cfg.getString('text_alignment', 'left'),
      };
    case 'image':
      return { ...base, type: 'image', label: cfg.getString('label', '') };
    case 'button': {
      const byId = RETVAL_IDS[cfg.getString('return_value_id', '')] ?? RETVAL_IDS[id];
      return {
        ...base,
        type: 'button',
        label: text(cfg, 'label'),
        returnValue: cfg.hasAttribute('return_value') ? cfg.getNumber('return_value') : (byId ?? GUI_RETVAL.NONE),
        markup: cfg.getBoolean('use_markup', false),
        enabled: true,
      };
    }
    case 'menu_button': {
      const options = cfg.children('option').map((o) => text(o, 'label'));
      return { ...base, type: 'menu_button', options, selectedIndex: options.length > 0 ? 1 : 0, markup: cfg.getBoolean('use_markup', false), enabled: true };
    }
    case 'spacer':
      return { ...base, type: 'spacer', width: cfg.getNumber('width', 0), height: cfg.getNumber('height', 0) };
    case 'listbox':
    case 'horizontal_listbox': {
      const definition = cfg.child('list_definition')?.child('row');
      const rows: GuiNode[] = [];
      for (const dataRow of cfg.child('list_data')?.children('row') ?? []) {
        const values = new Map<string, WmlConfig>();
        for (const column of dataRow.children('column')) {
          for (const widget of column.children('widget')) values.set(widget.getString('id', ''), widget);
        }
        const columns = definition?.children('column') ?? [];
        rows.push({ type: 'grid', id: '', visibility: 'visible', rows: [columns.map((c) => cellOf(c, values))] });
      }
      const listbox: GuiNode = {
        ...base,
        type: 'listbox',
        horizontal: tag === 'horizontal_listbox',
        rows,
        selectedIndex: cfg.getBoolean('has_minimum', true) && rows.length > 0 ? 1 : 0,
      };
      listDefinitions.set(listbox, { definition, hasMinimum: cfg.getBoolean('has_minimum', true) });
      return listbox;
    }
    case 'toggle_panel':
    case 'panel': {
      const grid = cfg.child('grid');
      return { ...base, type: 'panel', child: grid ? gridOf(grid, overrides) : { type: 'spacer', id: '', visibility: 'visible', width: 0, height: 0 } };
    }
    default:
      return { ...base, type: 'unknown', tag };
  }
}

function merged(base: WmlConfig, over: WmlConfig): WmlConfig {
  const out = base.clone();
  for (const key of over.attributeNames()) if (key !== 'id') out.setAttribute(key, over.getRaw(key)!);
  return out;
}

/** Each listbox's `[list_definition]` row, for rows added later (kept off the node, which is cloned to show). */
const listDefinitions = new WeakMap<GuiNode, { definition: WmlConfig | undefined; hasMinimum: boolean }>();

/**
 * `listbox::add_row` with no data (Lua's `listbox:add_item()`): a new row from the `[list_definition]`,
 * appended; its 1-based index, or 0 for a widget that is not a listbox. Selects it when it is the first
 * and the listbox must always have a selection (`has_minimum`).
 */
export function addListboxRow(node: GuiNode): number {
  if (node.type !== 'listbox') return 0;
  const list = listDefinitions.get(node);
  const columns = list?.definition?.children('column') ?? [];
  node.rows.push({ type: 'grid', id: '', visibility: 'visible', rows: [columns.map((c) => cellOf(c))] });
  if (node.rows.length === 1 && list?.hasMinimum !== false) node.selectedIndex = 1;
  return node.rows.length;
}

/**
 * The widget a Lua path names: `/`-separated widget ids from `root`, each optionally `#n` for a listbox's
 * n-th row (`unit_list#3/unit_type`), the way upstream's widget proxies reach a row's children.
 */
export function findGuiWidgetByPath(root: GuiNode, path: string): GuiNode | undefined {
  let node: GuiNode | undefined = root;
  for (const segment of path.split('/')) {
    if (!node) return undefined;
    const m = /^(.*?)(?:#(\d+))?$/.exec(segment)!;
    if (m[1]) node = findGuiWidget(node, m[1]);
    if (node && m[2] !== undefined) node = node.type === 'listbox' ? node.rows[Number(m[2]) - 1] : undefined;
  }
  return node;
}

/** The widget tree of a `[resolution]` (or a `[grid]` directly). */
export function buildGuiDialog(resolution: WmlConfig): GuiDialogSpec {
  const grid = resolution.child('grid');
  return { root: grid ? gridOf(grid) : { type: 'unknown', id: '', visibility: 'visible', tag: 'resolution' } };
}

/** Every widget with this `id=` (listbox rows repeat their definition's ids; the first is what Lua's `dialog[id]` finds). */
export function findGuiWidget(node: GuiNode, id: string): GuiNode | undefined {
  if (node.id === id) return node;
  switch (node.type) {
    case 'grid':
      for (const row of node.rows) for (const cell of row) {
        const found = findGuiWidget(cell.widget, id);
        if (found) return found;
      }
      return undefined;
    case 'panel':
      return findGuiWidget(node.child, id);
    default:
      return undefined;
  }
}
