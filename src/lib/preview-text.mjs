const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** @param {string} value */
export function previewText(value) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= 200) return text;
  let end = 0;
  for (const part of graphemes.segment(text)) {
    const next = part.index + part.segment.length;
    if (next > 200) break;
    end = next;
  }
  const word = text.lastIndexOf(' ', end);
  if (word > 120) end = word;
  return `${text.slice(0, end).trimEnd()}…`;
}
