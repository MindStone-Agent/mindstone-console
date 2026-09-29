/**
 * Which setup steps a link may open (MindStone-Agent #102): only a known
 * step, and only when every step before it is reported done. A step the
 * status leaves out is not done.
 */
import { changeableStep, linkableStep, returnPage } from '../steps';

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

describe('changeableStep (MindStone-Agent #140)', () => {
  const all = { provider: DONE, persona: DONE, memory: DONE };

  it('opens each setup choice Settings can change, once the steps it needs are done', () => {
    expect(changeableStep('provider', {})).toBe('provider');
    expect(changeableStep('model', { provider: DONE })).toBe('model');
    expect(changeableStep('persona', { provider: DONE })).toBe('persona');
    expect(changeableStep('memory', { provider: DONE, persona: DONE })).toBe('memory');
    expect(changeableStep('connectors', all)).toBe('connectors');
  });

  it('refuses a step whose prerequisites are not done', () => {
    expect(changeableStep('model', {})).toBeUndefined();
    expect(changeableStep('memory', { provider: DONE, persona: NOT_DONE })).toBeUndefined();
    expect(changeableStep('connectors', { provider: DONE, persona: DONE })).toBeUndefined();
  });

  it('never opens access, about, finish or anything unknown', () => {
    for (const step of ['access', 'about', 'finish', 'constructor', '__proto__', '', null]) {
      expect([step, changeableStep(step, all)]).toEqual([step, undefined]);
    }
  });
});

describe('returnPage', () => {
  it('goes back only to a page it knows, Settings otherwise', () => {
    expect(returnPage('providers').path).toBe('/mindstone/providers');
    expect(returnPage('settings').path).toBe('/mindstone');
    for (const from of ['https://example.com', '//example.com', '/c/new', '__proto__', '', null]) {
      expect([from, returnPage(from).path]).toEqual([from, '/mindstone']);
    }
  });
});
