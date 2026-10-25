// Turns the assistant's Markdown reply into plain data (blocks of text pieces).
// chat.js builds the page elements from this data with textContent only, so nothing in a reply
// can ever run as code or load anything: <script> in a reply is shown as the text "<script>".

/** "Some **bold** text" -> [{ text: 'Some ' }, { text: 'bold', strong: true }, { text: ' text' }] */
export function parseInline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  const plain = (s) => {
    const t = s.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2'); // drop *italic* marks
    if (t) out.push({ text: t });
  };
  for (const m of text.matchAll(re)) {
    plain(text.slice(last, m.index));
    if (m[1] || m[2]) out.push({ text: m[1] || m[2], strong: true });
    else if (m[3]) out.push({ text: m[3] });
    else out.push({ text: `${m[4]} (${m[5]})` }); // links are shown as text, never made clickable
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => parseInline(c.trim()));

/**
 * Blocks: { type: 'p', lines: [inline[]] } | { type: 'h', inline } | { type: 'ul'|'ol', items: [inline[]] }
 *       | { type: 'table', rows: [inline[][]] }  (the first row is the header)
 */
export function parseReply(markdown) {
  const blocks = [];
  let current = null;
  const close = () => { current = null; };
  for (const raw of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) || /^\s*```/.test(line)) { close(); continue; }
    let m;
    if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) {
      blocks.push({ type: 'h', inline: parseInline(m[1].replace(/\s*#+\s*$/, '')) });
      close();
    } else if (isTableRow(line)) {
      if (isTableRule(line)) continue;
      if (current?.type !== 'table') { current = { type: 'table', rows: [] }; blocks.push(current); }
      current.rows.push(cells(line));
    } else if ((m = line.match(/^\s*[-*+\u2022]\s+(.*)$/)) || (m = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/))) {
      const type = m.length === 3 ? 'ol' : 'ul';
      const text = m.length === 3 ? m[2] : m[1];
      if (current?.type !== type) { current = { type, items: [] }; blocks.push(current); }
      current.items.push(parseInline(text));
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      if (current?.type !== 'p') { current = { type: 'p', lines: [] }; blocks.push(current); }
      current.lines.push(parseInline(m[1]));
    } else {
      if (current?.type !== 'p') { current = { type: 'p', lines: [] }; blocks.push(current); }
      current.lines.push(parseInline(line.trim()));
    }
  }
  return blocks;
}
