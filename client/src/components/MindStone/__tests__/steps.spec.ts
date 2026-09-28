/**
 * Which setup steps a link may open (MindStone-Agent #102): only a known
 * step, and only when every step before it is reported done. A step the
 * status leaves out is not done.
 */
import { linkableStep } from '../steps';

const DONE = { done: true, detail: 'done' };
const NOT_DONE = { done: false, detail: 'not done' };

describe('linkableStep', () => {
  it('opens a step once every step before it is done', () => {
    expect(linkableStep('memory', { provider: DONE, persona: DONE })).toBe('memory');
    expect(linkableStep('about', { provider: DONE, persona: DONE, memory: DONE })).toBe('about');
    expect(linkableStep('connectors', { provider: DONE, persona: DONE, memory: DONE })).toBe(
      'connectors',
    );
  });

  it('treats a step the status leaves out as not done', () => {
    expect(linkableStep('memory', { provider: DONE })).toBeUndefined();
    expect(linkableStep('connectors', { provider: DONE, persona: DONE })).toBeUndefined();
    expect(linkableStep('about', { provider: DONE, persona: DONE })).toBeUndefined();
    expect(linkableStep('memory', undefined)).toBeUndefined();
    expect(linkableStep('memory', {})).toBeUndefined();
  });

  it('refuses a step that is reported not done', () => {
    expect(linkableStep('memory', { provider: DONE, persona: NOT_DONE })).toBeUndefined();
  });

  it('opens only the steps it knows', () => {
    const all = { provider: DONE, persona: DONE, memory: DONE };
    for (const step of ['finish', 'access', 'provider', 'constructor', '__proto__', '', null]) {
      expect([step, linkableStep(step, all)]).toEqual([step, undefined]);
    }
  });
});
