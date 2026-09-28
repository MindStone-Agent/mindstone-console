/**
 * The in-page check behind expectOnScreen (lib/journey.ts), shared with its
 * offline self-test (lib/screen-check.selftest.mjs) so both run the same code.
 * It runs inside the browser (page.evaluate), so it must stay self-contained.
 *
 * Arguments: { needle, role, messageId }
 * - role 'assistant': the text must be in the rendered row whose id is the
 *   stored reply's messageId (LibreChat renders `id={messageId}` on each row),
 *   inside its assistant turn. If no row has that id (a client-side id that
 *   never got replaced), any visible assistant turn counts, and the result
 *   says so. A user bubble never counts.
 * - role 'user': only visible user turns count.
 * Returns 'by-id', 'assistant-turn', 'user-turn', or '' when not found.
 * "Visible" is what the browser renders: innerText of message bodies that
 * pass checkVisibility(), with markdown markers and whitespace flattened.
 */
function screenMatch({ needle, role, messageId }) {
  const flat = (s) =>
    String(s)
      .replace(/[*_`#>|~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const visible = (el) => (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);
  const bodiesIn = (root, turnClass) =>
    Array.from(root.querySelectorAll(`.${turnClass} [data-testid="message-body"]`)).filter(visible);
  const has = (bodies) => bodies.some((el) => flat(el.innerText).includes(needle));
  if (role === 'user') return has(bodiesIn(document, 'user-turn')) ? 'user-turn' : '';
  if (messageId) {
    const row = document.getElementById(messageId);
    if (row) return has(bodiesIn(row, 'agent-turn')) ? 'by-id' : '';
  }
  return has(bodiesIn(document, 'agent-turn')) ? 'assistant-turn' : '';
}

module.exports = { screenMatch };
