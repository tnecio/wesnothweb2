import { describe, expect, it } from 'vitest';
import { isForeignError, isNetworkFailure } from './errorKinds.js';

const origin = 'https://wesnoth.fun';

describe('which uncaught errors are the game’s', () => {
  it('the opaque cross-origin "Script error." is not', () => {
    expect(isForeignError({ message: 'Script error.', error: null, filename: '' }, origin)).toBe(true);
  });

  it("errors in another origin's or an extension's script are not", () => {
    const e = new TypeError('x');
    expect(isForeignError({ message: 'TypeError: x', error: e, filename: 'https://cdn.example.com/blocker.js' }, origin)).toBe(true);
    expect(isForeignError({ message: 'TypeError: x', error: e, filename: 'safari-web-extension://ABCD/content.js' }, origin)).toBe(true);
    expect(isForeignError({ message: 'TypeError: x', error: e, filename: 'chrome-extension://abcd/inject.js' }, origin)).toBe(true);
  });

  it("the game's own scripts' errors are, with or without a file name", () => {
    const e = new Error('boom');
    expect(isForeignError({ message: 'Error: boom', error: e, filename: 'https://wesnoth.fun/assets/index-abc.js' }, origin)).toBe(false);
    expect(isForeignError({ message: 'Error: boom', error: e, filename: 'blob:https://wesnoth.fun/1234' }, origin)).toBe(false);
    expect(isForeignError({ message: 'Error: boom', error: e, filename: '' }, origin)).toBe(false);
    // A real error that happens to say "Script error." still counts when it has an error object.
    expect(isForeignError({ message: 'Script error.', error: new Error('Script error.'), filename: 'https://wesnoth.fun/a.js' }, origin)).toBe(false);
  });

  it('a request failing on the network is not a crash; a module failing to load is', () => {
    expect(isNetworkFailure(new TypeError('Load failed'))).toBe(true);
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isNetworkFailure(new TypeError('Importing a module script failed.'))).toBe(false);
    expect(isNetworkFailure(new Error('Load failed'))).toBe(false);
    expect(isNetworkFailure('Load failed')).toBe(false);
  });
});
