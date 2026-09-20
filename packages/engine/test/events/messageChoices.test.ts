import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { Location } from '../../src/model/Location.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';
import { runFlow, type MessageInteraction, type InteractionResult, type Responder } from '../../src/events/interaction.js';

/**
 * Phase 17 E1: `[message]` blocks its event, and `[option]`/`[text_input]`
 * feed an answer back into it -- the port of `data/lua/wml/message.lua`'s
 * choice half. The shape under test is the one Two Brothers 3's password
 * puzzle depends on: with no `value=` on the options, `variable=` receives
 * the 1-based index of the option the player actually picked.
 */

function makeBoard(): GameBoard {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const map = GameMap.fromMapString('Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100, controller: 'human' }));
  board.addTeam(new Team(2, { gold: 100, controller: 'ai' }));
  return board;
}

function makeResolveType(): (id: string) => UnitType {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveType = MoveType.fromConfig(parseWml(''), terrainData);
  const attack = AttackType.fromConfig(parseWml(''));
  const cache = new Map<string, UnitType>();
  return (id: string) => {
    let t = cache.get(id);
    if (!t) {
      t = new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 1, -1, 500, [], '', true, false, false, moveType, [attack], []);
      cache.set(id, t);
    }
    return t;
  };
}

function makePump(board: GameBoard) {
  const manager = new EventManager();
  const pump = new EventPump(manager, { board, variables: new VariableStore(), resolveType: makeResolveType() });
  return { manager, pump };
}

function addEvent(manager: EventManager, wml: string): void {
  manager.addFromWml(parseWml(wml).child('event')!);
}

/** Runs the event, answering every message the same way, and returns the messages it showed. */
function fireAnswering(pump: EventPump, name: string, respond: Responder): MessageInteraction[] {
  const shown: MessageInteraction[] = [];
  runFlow(pump.fireFlow(name), (interaction) => {
    if (interaction.kind === 'message') shown.push(interaction);
    return respond(interaction);
  });
  return shown;
}

/** Always picks the same 1-based option index. */
function pick(index: number): Responder {
  return () => ({ value: index });
}

const PASSWORD_EVENT = `
  [event]
    name=guard
    [message]
      speaker=narrator
      message="Give the password."
      variable=password_picked
      [option]
        label=Sithrak!
      [/option]
      [option]
        label=Eleben!
      [/option]
      [option]
        label=Jarlom!
      [/option]
    [/message]
    [if]
      [variable]
        name=password_picked
        equals=$correct_password
      [/variable]
      [then]
        [set_variable]
          name=outcome
          value=passed
        [/set_variable]
      [/then]
      [else]
        [set_variable]
          name=outcome
          value=died
        [/set_variable]
      [/else]
    [/if]
  [/event]
`;

describe('[message] with [option] (Phase 17 E1)', () => {
  it('with no value=, variable= receives the 1-based index of the chosen option -- the Two Brothers 3 shape', () => {
    for (const [choice, outcome] of [
      [2, 'passed'],
      [3, 'died'],
    ] as const) {
      const { manager, pump } = makePump(makeBoard());
      pump.ctx.variables.set('correct_password', 2);
      addEvent(manager, PASSWORD_EVENT);

      const shown = fireAnswering(pump, 'guard', pick(choice));

      expect(shown).toHaveLength(1);
      expect(shown[0]!.options.map((o) => o.label)).toEqual(['Sithrak!', 'Eleben!', 'Jarlom!']);
      expect(pump.ctx.variables.getNumber('password_picked')).toBe(choice);
      expect(pump.ctx.variables.getString('outcome')).toBe(outcome);
    }
  });

  it('value= overrides the index', () => {
    const { manager, pump } = makePump(makeBoard());
    addEvent(
      manager,
      `
      [event]
        name=ask
        [message]
          speaker=narrator
          message="Which way?"
          variable=road
          [option]
            label=Left
            value=west
          [/option]
          [option]
            label=Right
            value=east
          [/option]
        [/message]
      [/event]
    `,
    );

    fireAnswering(pump, 'ask', pick(2));

    expect(pump.ctx.variables.getString('road')).toBe('east');
  });

  it('an option whose [show_if] fails is not shown, and the indices count only what was shown', () => {
    const { manager, pump } = makePump(makeBoard());
    pump.ctx.variables.set('has_key', 'no');
    addEvent(
      manager,
      `
      [event]
        name=door
        [message]
          speaker=narrator
          message="The door is locked."
          variable=picked
          [option]
            label=Unlock it
            [show_if]
              [variable]
                name=has_key
                equals=yes
              [/variable]
            [/show_if]
          [/option]
          [option]
            label=Knock
          [/option]
          [option]
            label=Walk away
          [/option]
        [/message]
      [/event]
    `,
    );

    const shown = fireAnswering(pump, 'door', pick(2));

    expect(shown[0]!.options.map((o) => o.label)).toEqual(['Knock', 'Walk away']);
    expect(pump.ctx.variables.getNumber('picked')).toBe(2); // "Walk away", not the hidden first option
  });

  it("runs the chosen option's [command] body, and only that one's", () => {
    const { manager, pump } = makePump(makeBoard());
    addEvent(
      manager,
      `
      [event]
        name=offer
        [message]
          speaker=narrator
          message="Take the gold?"
          [option]
            label=Yes
            [command]
              [set_variable]
                name=took
                value=taken
              [/set_variable]
            [/command]
          [/option]
          [option]
            label=No
            [command]
              [set_variable]
                name=took
                value=left
              [/set_variable]
            [/command]
          [/option]
        [/message]
      [/event]
    `,
    );

    fireAnswering(pump, 'offer', pick(1));

    expect(pump.ctx.variables.getString('took')).toBe('taken');
  });

  it('a [message] inside an option [command] blocks in turn, in order', () => {
    const { manager, pump } = makePump(makeBoard());
    addEvent(
      manager,
      `
      [event]
        name=nested
        [message]
          speaker=narrator
          message="Pick one."
          [option]
            label=Ask again
            [command]
              [message]
                speaker=narrator
                message="Are you sure?"
              [/message]
            [/command]
          [/option]
        [/message]
        [message]
          speaker=narrator
          message="Done."
        [/message]
      [/event]
    `,
    );

    const shown = fireAnswering(pump, 'nested', pick(1));

    expect(shown.map((i) => i.message.message)).toEqual(['Pick one.', 'Are you sure?', 'Done.']);
  });

  it('records each answer in ctx.choices, in the [input] shape upstream replays', () => {
    const { manager, pump } = makePump(makeBoard());
    pump.ctx.variables.set('side_number', 1);
    addEvent(
      manager,
      `
      [event]
        name=ask
        [message]
          speaker=narrator
          message="Your name?"
          [text_input]
            variable=hero_name
            label=Name
            text=Arvith
          [/text_input]
        [/message]
        [message]
          speaker=narrator
          message="Ready?"
          [option]
            label=Yes
          [/option]
          [option]
            label=No
          [/option]
        [/message]
      [/event]
    `,
    );

    runFlow(pump.fireFlow('ask'), (interaction): InteractionResult => {
      return interaction.kind === 'message' && interaction.textInput ? { text: 'Baran' } : { value: 2 };
    });

    expect(pump.ctx.variables.getString('hero_name')).toBe('Baran');
    expect(pump.ctx.choices).toEqual([
      { value: undefined, text: 'Baran', side: 1 },
      { value: 2, text: undefined, side: 1 },
    ]);
  });

  it('[text_input] defaults to the variable "input" and clamps max_length', () => {
    const { manager, pump } = makePump(makeBoard());
    addEvent(
      manager,
      `
      [event]
        name=ask
        [message]
          speaker=narrator
          message="Say something"
          [text_input]
            text=hello
            max_length=9999
          [/text_input]
        [/message]
      [/event]
    `,
    );

    const shown = fireAnswering(pump, 'ask', () => ({ text: 'typed' }));

    expect(shown[0]!.textInput).toEqual({ label: '', text: 'hello', maxLength: 256 });
    expect(pump.ctx.variables.getString('input')).toBe('typed');
  });

  it('an out-of-range answer is refused rather than guessed at', () => {
    const { manager, pump } = makePump(makeBoard());
    const logged: string[] = [];
    pump.ctx.log = (_level, msg) => logged.push(msg);
    addEvent(
      manager,
      `
      [event]
        name=ask
        [message]
          speaker=narrator
          message="Pick"
          variable=picked
          [option]
            label=Only
          [/option]
        [/message]
      [/event]
    `,
    );

    fireAnswering(pump, 'ask', pick(4));

    expect(pump.ctx.variables.getString('picked')).toBe('');
    expect(logged.some((m) => m.includes('invalid choice (4)'))).toBe(true);
  });
});

describe('[message] skipping and side_for (Phase 17 E1)', () => {
  it('Escape skips the rest of this event\'s plain messages, but not a later event\'s', () => {
    const { manager, pump } = makePump(makeBoard());
    addEvent(
      manager,
      `
      [event]
        name=speech
        [message]
          speaker=narrator
          message="One"
        [/message]
        [message]
          speaker=narrator
          message="Two"
        [/message]
        [message]
          speaker=narrator
          message="Three"
        [/message]
      [/event]
    `,
    );
    addEvent(
      manager,
      `
      [event]
        name=later
        [message]
          speaker=narrator
          message="Four"
        [/message]
      [/event]
    `,
    );

    const shown: string[] = [];
    const escapeOnFirst: Responder = (interaction) => {
      if (interaction.kind === 'message') shown.push(interaction.message.message);
      return { skip: true };
    };
    runFlow(pump.fireFlow('speech'), escapeOnFirst);
    runFlow(pump.fireFlow('later'), escapeOnFirst);

    expect(shown).toEqual(['One', 'Four']);
  });

  it('a message that asks something is shown even while skipping', () => {
    const { manager, pump } = makePump(makeBoard());
    addEvent(
      manager,
      `
      [event]
        name=speech
        [message]
          speaker=narrator
          message="One"
        [/message]
        [message]
          speaker=narrator
          message="Still here?"
          variable=answered
          [option]
            label=Yes
          [/option]
        [/message]
        [message]
          speaker=narrator
          message="Three"
        [/message]
      [/event]
    `,
    );

    const shown: string[] = [];
    runFlow(pump.fireFlow('speech'), (interaction) => {
      if (interaction.kind === 'message') shown.push(interaction.message.message);
      return { skip: true, value: 1 };
    });

    expect(shown).toEqual(['One', 'Still here?']);
    expect(pump.ctx.variables.getNumber('answered')).toBe(1);
  });

  it('side_for= drops a plain message no human side should see', () => {
    const { manager, pump } = makePump(makeBoard());
    addEvent(
      manager,
      `
      [event]
        name=aside
        [message]
          speaker=narrator
          side_for=2
          message="For the orcs only"
        [/message]
        [message]
          speaker=narrator
          side_for=1,2
          message="For anyone human"
        [/message]
      [/event]
    `,
    );

    const shown = fireAnswering(pump, 'aside', () => ({}));

    expect(shown.map((i) => i.message.message)).toEqual(['For anyone human']);
  });
});

describe('[message] speaker resolution still holds (Phase 16 behaviour)', () => {
  it('a message whose speaker is not on the map is skipped entirely', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=speech
        [message]
          speaker=Nobody
          message="..."
        [/message]
      [/event]
    `,
    );

    const shown = fireAnswering(pump, 'speech', () => ({}));

    expect(shown).toEqual([]);
    expect(pump.ctx.messages).toEqual([]);
  });

  it('a real speaker supplies the title and the hex to scroll to', () => {
    const board = makeBoard();
    const resolve = makeResolveType();
    board.addUnit(Unit.create(resolve('Hero'), 1, new Location(1, 2), { id: 'Arvith', name: 'Arvith' }));
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=speech
        [message]
          speaker=Arvith
          message="Here."
        [/message]
      [/event]
    `,
    );

    const shown = fireAnswering(pump, 'speech', () => ({}));

    expect(shown[0]!.message).toMatchObject({ title: 'Arvith', speakerLocation: { x: 1, y: 2 }, scroll: true });
  });
});
