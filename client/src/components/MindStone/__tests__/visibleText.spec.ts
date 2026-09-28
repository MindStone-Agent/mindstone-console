import { visibleText } from '../visibleText';

describe('visibleText', () => {
  it('shows every character the gateway refuses, and nothing else', () => {
    expect(visibleText('Wr‮en')).toBe('Wr\\u{202E}en');
    expect(visibleText('Warm️.')).toBe('Warm\\u{FE0F}.');
    expect(visibleText('ㅤname')).toBe('\\u{3164}name');
    expect(visibleText('one two')).toBe('one\\u{2028}two');
    expect(visibleText('a\u{E0101}b')).toBe('a\\u{E0101}b');
    expect(visibleText('line one\n\tline two, ça va')).toBe('line one\n\tline two, ça va');
  });

  it('shows every space but the plain one, so a run of them cannot push text out of view', () => {
    expect(visibleText('a b c d　e f')).toBe('a\\u{00A0}b\\u{202F}c\\u{2007}d\\u{3000}e f');
  });
});
