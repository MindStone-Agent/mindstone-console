/**
 * Persona text as the admin should read it (MindStone-Agent #105): every
 * non-printing character is shown as \u{XXXX}, so what the page shows is
 * everything the text holds: controls other than newline and tab, format
 * characters (bidi overrides, zero-width joiners), private use, unassigned
 * code points, default-ignorable ones (variation selectors, fillers), line and
 * paragraph separators, and blank-looking letters. The same set the gateway
 * refuses in new proposals; this covers older pending ones and personas
 * written on the host.
 */
const NON_PRINTING =
  /[^\P{C}\n\t]|\p{Default_Ignorable_Code_Point}|[\u2028\u2029\u2800\u3164\uFFA0\u115F\u1160]/gu;

export function visibleText(text: string): string {
  return text.replace(NON_PRINTING, (char) => {
    const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    return `\\u{${code}}`;
  });
}
