import { test, expect } from 'vitest';
import { splitReplies } from '../../../src/shared/reply-options';

const question = 'Which feels most like your bet?';
const block = '<replies>\n<reply>Existing reactors cashing in now</reply>\n<reply>Uranium supply squeeze</reply>\n<reply>Small reactor startups</reply>\n<other>My angle\'s different…</other>\n</replies>';

test('a final replies block becomes reply buttons and leaves the visible text', () => {
  expect(splitReplies(`${question}\n\n${block}\n`)).toEqual({
    text: question,
    replies: { options: ['Existing reactors cashing in now', 'Uranium supply squeeze', 'Small reactor startups'], other: 'My angle\'s different…' },
  });
});

test('a block that is not last, or has no answers, is not turned into buttons', () => {
  const quoted = `${question}\n\n${block}\n\nMore text after it.`;
  expect(splitReplies(quoted)).toEqual({ text: quoted, replies: null });
  expect(splitReplies(`${question}\n<replies><other>Something else…</other></replies>`)).toEqual({ text: question, replies: null });
  expect(splitReplies('No buttons here.')).toEqual({ text: 'No buttons here.', replies: null });
});

test('answers are cleaned, deduplicated and capped', () => {
  const long = 'x'.repeat(81);
  const { replies } = splitReplies(`Q?\n<replies><reply>  One\n answer </reply><reply>One answer</reply><reply>${long}</reply><reply>Two</reply><reply>Three</reply><reply>Four</reply><reply>Five</reply></replies>`);
  expect(replies).toEqual({ options: ['One answer', 'Two', 'Three', 'Four'] });
});

test('while streaming, an unfinished block is hidden; afterwards an unclosed one is shown as written', () => {
  expect(splitReplies(`${question}\n<replies>\n<reply>Existing reac`, true)).toEqual({ text: question, replies: null });
  expect(splitReplies(`${question}\n<repl`, true)).toEqual({ text: question, replies: null });
  expect(splitReplies(`${question}\n<repl`)).toEqual({ text: `${question}\n<repl`, replies: null });
  const unclosed = `${question}\n<replies><reply>A</reply>`;
  expect(splitReplies(unclosed)).toEqual({ text: unclosed, replies: null });
});
