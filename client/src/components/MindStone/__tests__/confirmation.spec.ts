import { CONFIRMATION, confirmationMatches, normalizeConfirmation } from '../confirmation';

describe('advanced-settings confirmation (mindstone-console #18)', () => {
  it('normalizes case, surrounding whitespace and runs of whitespace', () => {
    expect(normalizeConfirmation('Enable Advanced Settings')).toBe(CONFIRMATION);
    expect(normalizeConfirmation('  enable advanced settings  ')).toBe(CONFIRMATION);
    expect(normalizeConfirmation('enable  advanced \t settings')).toBe(CONFIRMATION);
    expect(normalizeConfirmation('Enable advanced settings ')).toBe(CONFIRMATION);
    expect(normalizeConfirmation('\nENABLE ADVANCED SETTINGS\n')).toBe(CONFIRMATION);
  });

  it.each([
    'enable advanced settings',
    'Enable advanced settings',
    'Enable Advanced Settings ',
    '  enable  advanced   settings  ',
  ])('accepts %j', (text) => {
    expect(confirmationMatches(text)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'enable advanced setting',
    'enable advancedsettings',
    'enable advanced settings now',
    'please enable advanced settings',
    'enable-advanced-settings',
  ])('refuses %j', (text) => {
    expect(confirmationMatches(text)).toBe(false);
  });
});
