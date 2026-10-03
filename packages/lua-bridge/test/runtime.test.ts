import { describe, expect, it } from 'vitest';
import { GameBoard } from '@wesnothweb2/engine/src/model/GameBoard.js';
import { GameMap } from '@wesnothweb2/engine/src/model/Map.js';
import { TerrainTypeData } from '@wesnothweb2/engine/src/model/Terrain.js';
import { Team } from '@wesnothweb2/engine/src/model/Team.js';
import { EventManager, EventPump } from '@wesnothweb2/engine/src/events/pump.js';
import { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { parseWml } from '@wesnothweb2/engine/src/wml/index.js';
import { runActionSequence } from '@wesnothweb2/engine/src/events/actionWml.js';
import { autoRespond, guiSelectionAnswer, runFlow, type Interaction, type InteractionResult } from '@wesnothweb2/engine/src/events/interaction.js';
import type { GuiNode } from '@wesnothweb2/engine/src/events/guiDialog.js';
import { LuaRuntime, type LuaSources } from '../src/runtime.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLuaDataDir } from '../src/dataLua.js';

const dataFiles = loadLuaDataDir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../wesnoth/data'));

/** Phase 28c: a campaign's own Lua -- `[lua]` actions, Lua-defined WML tags, and `gui.show_dialog`. */

function setup(sources: Partial<LuaSources> = {}) {
  const map = GameMap.fromMapString('Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg', TerrainTypeData.fromConfigs([]));
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100 }));
  const manager = new EventManager();
  const logs: string[] = [];
  const pump = new EventPump(manager, {
    board,
    variables: new VariableStore(),
    resolveType: () => {
      throw new Error('no unit types here');
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  const runtime = new LuaRuntime({ modules: {}, wml: {}, ...sources }, () => pump.ctx, { dataFiles });
  const run = (wml: string, respond?: (i: Interaction) => InteractionResult) => runActionSequence(parseWml(wml), pump.ctx, respond);
  return { pump, manager, runtime, run, logs, vars: pump.ctx.variables };
}

describe('[lua] actions', () => {
  it('run their code with [args] as ...', () => {
    const { run, vars } = setup();
    run(`[lua]
      code=<< local args = ... ; wml.variables.answer = args.n * 2 >>
      [args]
        n=21
      [/args]
    [/lua]`);
    expect(vars.getNumber('answer')).toBe(42);
  });

  it('are not $-substituted (their code is Lua)', () => {
    const { run, vars } = setup();
    vars.set('x', 'oops');
    run(`[lua]
      code=<< wml.variables.out = "$x" >>
    [/lua]`);
    expect(vars.getString('out')).toBe('$x');
  });

  it('report a Lua error in the log instead of throwing', () => {
    const { run, logs } = setup();
    run(`[lua]
      code=<< error("boom") >>
    [/lua]`);
    expect(logs.some((l) => l.startsWith('error:') && l.includes('boom'))).toBe(true);
  });
});

describe('gui.show_help', () => {
  it('shows the help (an openHelp beat), and the Lua goes on once it is closed', () => {
    const { run, vars } = setup();
    const seen: Interaction[] = [];
    run(`[lua]
      code=<< gui.show_help("unit_Fencer") ; wml.variables.after = "yes" >>
    [/lua]`, (i) => {
      seen.push(i);
      expect(vars.getString('after')).toBe('');
      return autoRespond(i);
    });
    expect(seen).toEqual([{ kind: 'beat', beat: { kind: 'openHelp', topic: 'unit_Fencer' } }]);
    expect(vars.getString('after')).toBe('yes');
  });
});

describe('WML tags defined in Lua', () => {
  it('run when WML reaches the tag, and can call native tags that stop for the player', () => {
    const { run, pump, vars } = setup();
    run(`[lua]
      code=<<
        local _ = wesnoth.textdomain "wesnoth"
        function wesnoth.wml_actions.greet(cfg)
          wesnoth.wml_actions.message { speaker = "narrator", message = _"Hello" .. ", " .. cfg.who }
          wml.variables.greeted = cfg.who
        end
      >>
    [/lua]`);
    const seen: Interaction[] = [];
    run(`[greet]
      who=Kai
    [/greet]`, (i) => {
      seen.push(i);
      return autoRespond(i);
    });
    expect(seen.map((i) => i.kind)).toEqual(['message']);
    expect(pump.ctx.messages.at(-1)?.message).toBe('Hello, Kai');
    // The variable is set after the message was answered: the Lua was suspended in between.
    expect(vars.getString('greeted')).toBe('Kai');
  });

  it('can wrap a native tag and still reach it', () => {
    const { run, vars } = setup();
    run(`[lua]
      code=<<
        local original = wesnoth.wml_actions.set_variable
        function wesnoth.wml_actions.set_variable(cfg)
          wml.variables.wrapped = (wml.variables.wrapped or 0) + 1
          original(cfg)
        end
      >>
    [/lua]`);
    run(`[set_variable]
      name=a
      value=1
    [/set_variable]
    [set_variable]
      name=b
      value=2
    [/set_variable]`);
    expect(vars.getNumber('a')).toBe(1);
    expect(vars.getNumber('b')).toBe(2);
    expect(vars.getNumber('wrapped')).toBe(2);
  });

  it('fire events that run WML, including messages', () => {
    const { run, manager, pump, vars } = setup();
    manager.addFromWml(parseWml(`[event]
      name=ping
      first_time_only=no
      [set_variable]
        name=pinged
        add=1
      [/set_variable]
      [message]
        speaker=narrator
        message=pong
      [/message]
    [/event]`).child('event')!);
    run(`[lua]
      code=<< wesnoth.game_events.fire("ping") ; wesnoth.game_events.fire("ping") >>
    [/lua]`);
    expect(vars.getNumber('pinged')).toBe(2);
    expect(pump.ctx.messages.filter((m) => m.message === 'pong')).toHaveLength(2);
  });

  it('skip messages when asked, and read the flag back', () => {
    const { run, vars, pump } = setup();
    run(`[lua]
      code=<< wesnoth.interface.skip_messages() ; wml.variables.skipping = wesnoth.interface.is_skipping_messages() >>
    [/lua]
    [message]
      speaker=narrator
      message=unseen
    [/message]`);
    expect(vars.getBoolean('skipping')).toBe(true);
    expect(pump.ctx.messages.some((m) => m.message === 'unseen')).toBe(false);
  });
});

describe('modules and files', () => {
  it('require runs a module once; dofile every time; wml.load reads a carried file', () => {
    const { run, vars } = setup({
      modules: {
        'campaigns/X/lua/counter.lua': 'wml.variables.loads = (wml.variables.loads or 0) + 1',
      },
      wml: { 'campaigns/X/gui/d.cfg': parseWml('[resolution]\nid=r\n[/resolution]').toJSON() },
    });
    run(`[lua]
      code=<<
        wesnoth.require "campaigns/X/lua/counter"
        wesnoth.require "campaigns/X/lua/counter"
        wesnoth.dofile "campaigns/X/lua/counter.lua"
        local cfg = wml.load "campaigns/X/gui/d.cfg"
        wml.variables.loaded_id = wml.get_child(cfg, "resolution").id
      >>
    [/lua]`);
    expect(vars.getNumber('loads')).toBe(2);
    expect(vars.getString('loaded_id')).toBe('r');
  });

  it('preload scripts run at initialize, before the scenario', () => {
    const { runtime, pump } = setup({ modules: { 'campaigns/X/lua/tags.lua': 'function wesnoth.wml_actions.mark(cfg) wml.variables.marked = cfg.v end' } });
    const scenario = parseWml(`[scenario]
      [lua]
        code=<< wesnoth.require "campaigns/X/lua/tags" >>
        game_config=yes
      [/lua]
    [/scenario]`).child('scenario')!;
    runFlow(runtime.initialize(scenario));
    runActionSequence(parseWml('[mark]\nv=7\n[/mark]'), pump.ctx);
    expect(pump.ctx.variables.getNumber('marked')).toBe(7);
  });
});

describe('gui.show_prompt (show_message_box)', () => {
  /** The labels and buttons a prompt shows. */
  function texts(node: GuiNode, out: string[] = []): string[] {
    if ((node.type === 'label' || node.type === 'button') && 'label' in node) {
      const l = node.label;
      out.push(`${node.type}:${typeof l === 'string' ? l : JSON.stringify(l).replace(/.*\["wesnoth-lib","([^"]+)"\].*/, '$1')}`);
    }
    if (node.type === 'grid') for (const row of node.rows) for (const cell of row) texts(cell.widget, out);
    return out;
  }

  it('shows the message with an OK button by default, and returns nothing', () => {
    const { run, vars } = setup();
    const shown: string[][] = [];
    run(`[lua]
      code=<< wml.variables.r = select("#", gui.show_prompt("", "There are no corpses available.", "")) >>
    [/lua]`, (i) => {
      if (i.kind === 'guiDialog') shown.push(texts(i.dialog.root));
      return { value: -1 };
    });
    expect(shown).toEqual([['label:There are no corpses available.', 'button:OK']]);
    expect(vars.getNumber('r')).toBe(0);
  });

  it('yes_no returns whether Yes was chosen; a title shows above the message', () => {
    const { run, vars } = setup();
    const shown: string[][] = [];
    run(`[lua]
      code=<< wml.variables.yes = gui.show_prompt("Title", "Sure?", "yes_no") ; wml.variables.no = gui.show_prompt("Title", "Sure?", "yes_no") >>
    [/lua]`, (i) => {
      if (i.kind !== 'guiDialog') return {};
      shown.push(texts(i.dialog.root));
      return { value: shown.length === 1 ? -1 : -2 };
    });
    expect(shown[0]).toEqual(['label:Title', 'label:Sure?', 'button:Yes', 'button:No']);
    expect([vars.getBoolean('yes'), vars.getBoolean('no')]).toEqual([true, false]);
  });
});

describe('gui.show_dialog', () => {
  const DIALOG = `[resolution]
    [grid]
      [row]
        [column]
          [label]
            id=title
          [/label]
        [/column]
      [/row]
      [row]
        [column]
          [horizontal_listbox]
            id=characters
            has_minimum=false
            [list_definition]
              [row]
                [column]
                  [toggle_panel]
                    [grid]
                      [row]
                        [column]
                          [label]
                            id=name
                          [/label]
                        [/column]
                      [/row]
                    [/grid]
                  [/toggle_panel]
                [/column]
              [/row]
            [/list_definition]
            [list_data]
              [row]
                [column]
                  [widget]
                    id=name
                    label=Gerrick
                  [/widget]
                [/column]
              [/row]
              [row]
                [column]
                  [widget]
                    id=name
                    label=Mari
                  [/widget]
                [/column]
              [/row]
            [/list_data]
          [/horizontal_listbox]
        [/column]
      [/row]
      [row]
        [column]
          [button]
            id=leave
            return_value=1
            label=Leave
          [/button]
        [/column]
      [/row]
    [/grid]
  [/resolution]`;

  const labels = (node: GuiNode): string[] => {
    const out: string[] = [];
    const walk = (n: GuiNode): void => {
      if (n.type === 'label' && typeof n.label === 'string' && n.label) out.push(n.label);
      if (n.type === 'grid') n.rows.forEach((r) => r.forEach((c) => walk(c.widget)));
      if (n.type === 'panel') walk(n.child);
      if (n.type === 'listbox') n.rows.forEach(walk);
    };
    walk(node);
    return out;
  };

  it('shows the preshow state, and returns the button the player pressed', () => {
    const { run, vars, logs } = setup({ wml: { 'd.cfg': parseWml(DIALOG).toJSON() } });
    const shown: Interaction[] = [];
    run(`[lua]
      code=<<
        local cfg = wml.load "d.cfg"
        local r = gui.show_dialog(wml.get_child(cfg, "resolution"), function(dialog)
          dialog["title"].label = "Pick one"
        end)
        wml.variables.button = r
      >>
    [/lua]`, (i) => {
      shown.push(i);
      return { value: 1 };
    });
    expect(logs.filter((l) => l.startsWith('error'))).toEqual([]);
    expect(shown).toHaveLength(1);
    const dialog = shown[0]!;
    expect(dialog.kind).toBe('guiDialog');
    if (dialog.kind === 'guiDialog') expect(labels(dialog.dialog.root)).toEqual(['Pick one', 'Gerrick', 'Mari']);
    expect(vars.getNumber('button')).toBe(1);
  });

  it("runs a listbox's on_modified when a row is picked, which may fire events and close the dialog", () => {
    const { run, vars, manager } = setup({ wml: { 'd.cfg': parseWml(DIALOG).toJSON() } });
    manager.addFromWml(parseWml(`[event]
      name=ask
      [set_variable]
        name=asked
        value=yes
      [/set_variable]
    [/event]`).child('event')!);
    const shown: Interaction[] = [];
    run(`[lua]
      code=<<
        local cfg = wml.load "d.cfg"
        local r = gui.show_dialog(wml.get_child(cfg, "resolution"), function(dialog)
          dialog["leave"].visible = false
          dialog["characters"].on_modified = function()
            wml.variables.picked = dialog["characters"].selected_index
            wesnoth.game_events.fire("ask")
            dialog:close()
          end
        end)
        wml.variables.button = r
      >>
    [/lua]`, (i) => {
      shown.push(i);
      return guiSelectionAnswer('characters', 2);
    });
    expect(shown).toHaveLength(1);
    expect(vars.getNumber('picked')).toBe(2);
    expect(vars.getBoolean('asked')).toBe(true);
    // Closed by close(): upstream's retval NONE.
    expect(vars.getNumber('button')).toBe(0);
  });
});
