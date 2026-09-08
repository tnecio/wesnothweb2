import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { parseWml } from '../../src/wml/index.js';

describe('WmlConfig JSON round-trip', () => {
  it('preserves attributes, attribute types, and ordered/repeated children through JSON.stringify/parse', () => {
    const cfg = new WmlConfig();
    cfg.setAttribute('name', 'test');
    cfg.setAttribute('count', 3);
    cfg.setAttribute('active', true);
    cfg.addChild('a', new WmlConfig().setAttribute('x', 1));
    cfg.addChild('b', new WmlConfig().setAttribute('y', 2));
    cfg.addChild('a', new WmlConfig().setAttribute('x', 4)); // repeated tag, must stay ordered

    const roundTripped = WmlConfig.fromJSON(JSON.parse(JSON.stringify(cfg.toJSON())));

    expect(roundTripped.getString('name')).toBe('test');
    expect(roundTripped.getNumber('count')).toBe(3);
    expect(roundTripped.getBoolean('active')).toBe(true);
    expect(roundTripped.allChildren().map((c) => c.tag)).toEqual(['a', 'b', 'a']);
    expect(roundTripped.children('a').map((c) => c.getNumber('x'))).toEqual([1, 4]);
  });

  it('round-trips a real, non-trivial parsed WML tree (a scenario [event] block)', () => {
    const wml = `
[event]
    name=prestart
    [message]
        speaker=narrator
        message= _ "Hello, world."
    [/message]
    [if]
        [variable]
            name=turn_number
            equals=1
        [/variable]
        [then]
            [set_variable]
                name=greeted
                value=yes
            [/set_variable]
        [/then]
    [/if]
[/event]
`;
    const original = parseWml(wml);
    const roundTripped = WmlConfig.fromJSON(JSON.parse(JSON.stringify(original.toJSON())));

    const event = roundTripped.child('event')!;
    expect(event.getString('name')).toBe('prestart');
    expect(event.child('message')!.getString('speaker')).toBe('narrator');
    const ifTag = event.child('if')!;
    expect(ifTag.child('variable')!.getString('name')).toBe('turn_number');
    // The parser coerces bare yes/no attribute values to real booleans
    // (same behavior the animation work's `hits=yes/no` bug hinged on) --
    // getBoolean, not getString, is the right check here.
    expect(ifTag.child('then')!.child('set_variable')!.getBoolean('value')).toBe(true);
  });
});
