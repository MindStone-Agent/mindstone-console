/**
 * The advanced-settings confirmation phrase (mindstone-console #18). It guards
 * against accidents, not attackers, so case, surrounding whitespace and
 * repeated spaces don't matter; the words must still match exactly. The
 * gateway normalizes the same way. The normalized text is what gets sent, so
 * an older gateway that compares exactly accepts it too.
 */
export const CONFIRMATION = 'enable advanced settings';

export function normalizeConfirmation(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function confirmationMatches(text: string): boolean {
  return normalizeConfirmation(text) === CONFIRMATION;
}
