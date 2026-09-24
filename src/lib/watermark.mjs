export const watermarkCreditError = 'Use up to 200 characters on one or two nonempty watermark lines, without control characters.';

/** @param {unknown} value */
export function normalizeWatermarkCredit(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(watermarkCreditError);
  const normalized = value.replace(/\r\n?/g, '\n');
  if (normalized.length > 200 || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]|\p{Surrogate}/u.test(normalized)) throw new Error(watermarkCreditError);
  if (!normalized.trim()) return '';
  const lines = normalized.split('\n').map((line) => line.trim());
  if (lines.length > 2 || lines.some((line) => !line)) throw new Error(watermarkCreditError);
  return lines.join('\n');
}

/**
 * Both renderers measure their own sans-serif font, then share the same unstretched
 * layout. The padding includes the stroke and a transparent bottom/right margin.
 * @param {string} creator
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {(text: string, fontSize: number) => number | Promise<number>} measure
 */
export async function watermarkLayout(creator, imageWidth, imageHeight, measure) {
  const credit = normalizeWatermarkCredit(creator);
  if (!credit) throw new Error(watermarkCreditError);
  const lines = credit.split('\n').map((text, index) => ({ text, fontSize: index === 0 ? 28 : 20, x: 24, y: 40 + index * 28 }));
  const widths = await Promise.all(lines.map((line) => measure(line.text, line.fontSize)));
  if (widths.some((width) => !Number.isFinite(width) || width < 0)) throw new Error('The watermark font could not be measured.');
  const nominalWidth = Math.max(180, ...widths.map((width) => Math.ceil(width) + 64));
  const nominalHeight = lines.length === 1 ? 76 : 96;
  const scale = Math.min(1, Math.min(460, Math.max(1, Math.floor(imageWidth * 0.38))) / nominalWidth, imageHeight / nominalHeight);
  const width = Math.max(1, Math.floor(nominalWidth * scale));
  const height = Math.max(1, Math.floor(nominalHeight * scale));
  return { lines, width, height, scale: Math.min(width / nominalWidth, height / nominalHeight) };
}
