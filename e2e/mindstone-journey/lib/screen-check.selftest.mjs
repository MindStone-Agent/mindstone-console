// Offline self-test of the J4/J6 on-screen check (lib/screen-match.js), in a
// real Chromium page but without the Console: it builds LibreChat-shaped
// message rows and requires that
// - a reply shown in its assistant row is found (by messageId, and by turn);
// - the same text only in the user's own bubble is NOT found as the reply
//   (J6's codeword and "Noted." are both in the user's message);
// - a hidden assistant body is NOT found (display:none on its contents);
// - a user turn is found only among user turns.
// Run by run-journey.sh as row X5; needs @playwright/test (NODE_PATH).
//
//   node screen-check.selftest.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const { screenMatch } = require('./screen-match.js');

const row = (id, turn, text, hidden = false) => `
  <div id="${id}" role="group" class="message-render">
    <div class="${turn}">
      <div data-testid="message-body"${hidden ? ' class="hide"' : ''}><div class="markdown"><p>${text}</p></div></div>
    </div>
  </div>`;

const cases = [
  {
    name: 'reply in its assistant row, by messageId',
    html: row('u1', 'user-turn', 'What is my codename?') + row('a1', 'agent-turn', 'Your codename is **amber-heron-4242**.'),
    arg: { needle: 'Your codename is amber-heron-4242.', role: 'assistant', messageId: 'a1' },
    want: 'by-id',
  },
  {
    name: 'reply text only in the user bubble is not the reply',
    html: row('u1', 'user-turn', 'my project codename is amber-heron-4242. Just reply "Noted."') + row('a1', 'agent-turn', 'Sure.'),
    arg: { needle: 'amber-heron-4242', role: 'assistant', messageId: 'a1' },
    want: '',
  },
  {
    name: 'user-bubble text is not found even without a messageId',
    html: row('u1', 'user-turn', 'Just reply "Noted."') + row('a1', 'agent-turn', 'Okay.'),
    arg: { needle: 'Noted.', role: 'assistant' },
    want: '',
  },
  {
    name: 'hidden assistant body is not found (the blank-assistant sabotage)',
    html: row('u1', 'user-turn', 'hello') + row('a1', 'agent-turn', 'Hello back!', true),
    arg: { needle: 'Hello back!', role: 'assistant', messageId: 'a1' },
    want: '',
  },
  {
    name: 'reply under another id: the row with the stored id decides',
    html: row('a0', 'agent-turn', 'Hello back!') + row('a1', 'agent-turn', 'Something else.'),
    arg: { needle: 'Hello back!', role: 'assistant', messageId: 'a1' },
    want: '',
  },
  {
    name: 'no row with the stored id: any visible assistant turn, reported as such',
    html: row('tmp-1', 'agent-turn', 'Hello back!'),
    arg: { needle: 'Hello back!', role: 'assistant', messageId: 'a1' },
    want: 'assistant-turn',
  },
  {
    name: 'user turn found among user turns',
    html: row('u1', 'user-turn', 'Please say hello back.'),
    arg: { needle: 'Please say hello back.', role: 'user' },
    want: 'user-turn',
  },
  {
    name: 'user text only in an assistant row is not a user turn',
    html: row('a1', 'agent-turn', 'Please say hello back.'),
    arg: { needle: 'Please say hello back.', role: 'user' },
    want: '',
  },
];

const browser = await chromium.launch();
let failures = 0;
try {
  const page = await browser.newPage();
  for (const c of cases) {
    await page.setContent(`<style>.hide * { display: none !important; }</style>${c.html}`);
    const got = await page.evaluate(screenMatch, c.arg);
    const ok = got === c.want;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name}${ok ? '' : ` (got "${got}", want "${c.want}")`}`);
  }
} finally {
  await browser.close();
}
console.log(`screen-check self-test: ${cases.length - failures} of ${cases.length} controls behaved`);
process.exit(failures ? 1 : 0);
