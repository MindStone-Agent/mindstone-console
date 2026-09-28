/**
 * Persona text as the admin should read it (MindStone-Agent #105): every
 * non-printing character (controls other than newline and tab, format
 * characters such as bidi overrides and zero-width joiners, private use,
 * unassigned code points) is shown as \u{XXXX}, so what the page shows is
 * everything the text holds. The gateway refuses these in new proposals;
 * this covers older pending ones and personas written on the host.
 */
const NON_PRINTING = /[^\P{C}\n\t]/gu;

export function visibleText(text: string): string {
  return text.replace(NON_PRINTING, (char) => {
    const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    return `\\u{${code}}`;
  });
}
