/**
 * Reply buttons. A reply may end with one block the app turns into buttons:
 *
 *   <replies>
 *   <reply>Existing reactors cashing in now</reply>
 *   <reply>Uranium supply squeeze</reply>
 *   <other>My angle's different…</other>
 *   </replies>
 *
 * The block is model output, so it only ever becomes text the member can send
 * themselves; it never runs anything.
 */
export interface ReplyOptions { options: string[]; other?: string }

export const replyFormat = 'When you end with a question that has a few likely answers, add one block at the very end of your reply: <replies>, then two to four <reply>answer</reply> lines of at most eight words each, worded as the user would say them, then optionally one <other>short invitation to answer differently</other>, then </replies>. Write nothing after it. The app shows these as reply buttons and hides the block.';

const open = '<replies>';
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Splits a reply into its visible text and its reply buttons. While streaming, an unfinished block is hidden too. */
export function splitReplies(text: string, streaming = false): { text: string; replies: ReplyOptions | null } {
  const start = text.lastIndexOf(open);
  if (start < 0) {
    if (!streaming) return { text, replies: null };
    // Hide a block that has started to arrive but isn't recognizable yet: "…?\n<rep".
    for (let size = open.length - 1; size > 0; size--) if (text.endsWith(open.slice(0, size))) return { text: text.slice(0, -size).trimEnd(), replies: null };
    return { text, replies: null };
  }
  const rest = text.slice(start + open.length);
  const end = rest.indexOf('</replies>');
  if (end < 0) return streaming ? { text: text.slice(0, start).trimEnd(), replies: null } : { text, replies: null };
  // Only a final block is a reply-button block; one quoted mid-message is left as written.
  if (rest.slice(end + '</replies>'.length).trim()) return { text, replies: null };
  const body = rest.slice(0, end);
  const options = [...new Set([...body.matchAll(/<reply>([\s\S]*?)<\/reply>/g)].map(match => clean(match[1])))]
    .filter(option => option.length > 0 && option.length <= 80).slice(0, 4);
  const other = clean(body.match(/<other>([\s\S]*?)<\/other>/)?.[1] ?? '').slice(0, 60);
  return { text: text.slice(0, start).trimEnd(), replies: options.length ? { options, ...(other ? { other } : {}) } : null };
}
