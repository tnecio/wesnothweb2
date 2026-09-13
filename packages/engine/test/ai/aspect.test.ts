import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { isAspectActive, facetFromConfig, CompositeAspect } from '../../src/ai/composite/aspect.js';

/**
 * `isAspectActive` (mirrors `readonly_context_impl::is_active`,
 * `src/ai/contexts.cpp:1192`) and `CompositeAspect.resolve` (mirrors
 * `composite_aspect::recalculate`): facet activation by `turns=`/
 * `time_of_day=`, and "last-added active facet wins, else default".
 */

describe('isAspectActive', () => {
  it('is always active when both turns= and time_of_day= are empty', () => {
    expect(isAspectActive('', '', 1, 'dawn')).toBe(true);
    expect(isAspectActive('', '', 999, 'midnight')).toBe(true);
  });

  it('turns=: matches a bare number, a range, and an open-ended range', () => {
    expect(isAspectActive('3', '', 3, '')).toBe(true);
    expect(isAspectActive('3', '', 4, '')).toBe(false);
    expect(isAspectActive('5-9', '', 5, '')).toBe(true);
    expect(isAspectActive('5-9', '', 9, '')).toBe(true);
    expect(isAspectActive('5-9', '', 10, '')).toBe(false);
    expect(isAspectActive('12-', '', 100, '')).toBe(true);
    expect(isAspectActive('12-', '', 11, '')).toBe(false);
  });

  it('turns=: a comma list matches if any part matches', () => {
    expect(isAspectActive('1,5-9,12-', '', 7, '')).toBe(true);
    expect(isAspectActive('1,5-9,12-', '', 10, '')).toBe(false);
  });

  it('time_of_day=: a comma list of ids must contain the current id', () => {
    expect(isAspectActive('', 'dawn,dusk', 1, 'dawn')).toBe(true);
    expect(isAspectActive('', 'dawn,dusk', 1, 'midnight')).toBe(false);
  });

  it('a non-matching time_of_day= fails immediately, regardless of turns=', () => {
    expect(isAspectActive('1-100', 'dusk', 5, 'dawn')).toBe(false);
  });

  it('both given: both must match', () => {
    expect(isAspectActive('5-9', 'dawn', 7, 'dawn')).toBe(true);
    expect(isAspectActive('5-9', 'dawn', 10, 'dawn')).toBe(false);
    expect(isAspectActive('5-9', 'dawn', 7, 'dusk')).toBe(false);
  });
});

function makeFacet(id: string, value: string, turns = '', timeOfDay = ''): ReturnType<typeof facetFromConfig> {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', id);
  cfg.setAttribute('turns', turns);
  cfg.setAttribute('time_of_day', timeOfDay);
  cfg.setAttribute('value', value);
  return facetFromConfig(cfg);
}

describe('CompositeAspect.resolve', () => {
  it('falls back to the default facet when no facet is active', () => {
    const aspect = new CompositeAspect('aggression', makeFacet('', '0.4'));
    expect(aspect.resolve(1, '').getString('value')).toBe('0.4');
  });

  it('an active facet overrides the default', () => {
    const aspect = new CompositeAspect('aggression', makeFacet('', '0.4'));
    aspect.addFacet(makeFacet('scenario', '0.8'));
    expect(aspect.resolve(1, '').getString('value')).toBe('0.8');
  });

  it('the LAST-added active facet wins when several are active at once', () => {
    const aspect = new CompositeAspect('aggression', makeFacet('', '0.4'));
    aspect.addFacet(makeFacet('first', '0.6'));
    aspect.addFacet(makeFacet('second', '0.9'));
    expect(aspect.resolve(1, '').getString('value')).toBe('0.9');
  });

  it('an inactive facet (turns=/time_of_day= not matching) is skipped even if added last', () => {
    const aspect = new CompositeAspect('aggression', makeFacet('', '0.4'));
    aspect.addFacet(makeFacet('always', '0.6'));
    aspect.addFacet(makeFacet('night_only', '0.9', '', 'first_watch'));
    expect(aspect.resolve(1, 'dawn').getString('value')).toBe('0.6'); // night_only inactive -> falls through to 'always'
    expect(aspect.resolve(1, 'first_watch').getString('value')).toBe('0.9');
  });

  it('deleteFacet removes a facet by id and reports whether one was removed', () => {
    const aspect = new CompositeAspect('aggression', makeFacet('', '0.4'));
    aspect.addFacet(makeFacet('scenario', '0.8'));
    expect(aspect.deleteFacet('scenario')).toBe(true);
    expect(aspect.resolve(1, '').getString('value')).toBe('0.4');
    expect(aspect.deleteFacet('scenario')).toBe(false); // already gone
  });

  it('setDefault replaces the default facet', () => {
    const aspect = new CompositeAspect('aggression', makeFacet('', '0.4'));
    aspect.setDefault(makeFacet('', '0.1'));
    expect(aspect.resolve(1, '').getString('value')).toBe('0.1');
  });
});
