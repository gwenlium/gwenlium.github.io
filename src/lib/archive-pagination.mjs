/**
 * @template {{ id: string, date: string }} T
 * @param {T[]} entries
 * @param {{year?: string, sort?: string, page?: string | null}} options
 */
export function paginateArchive(entries, { year = '', sort = 'newest', page = null } = {}) {
  const ordered = entries.filter((entry) => !year || entry.date.slice(0, 4) === year)
    .sort((a, b) => (sort === 'oldest' ? 1 : -1) * (Date.parse(a.date) - Date.parse(b.date)) || a.id.localeCompare(b.id, 'en'));
  const pages = Math.max(1, Math.ceil(ordered.length / 10));
  const requested = Number(page);
  const current = Math.min(pages, Math.max(1, Number.isSafeInteger(requested) ? requested : 1));
  const offset = (current - 1) * 10;
  return { entries: ordered.slice(offset, offset + 10), total: ordered.length, page: current, pages, start: ordered.length ? offset + 1 : 0, end: Math.min(offset + 10, ordered.length) };
}

/** @param {number} current @param {number} total @returns {(number | null)[]} */
export function pageNumbers(current, total) {
  const numbers = [...new Set([1, total, current - 1, current, current + 1])].filter((number) => number >= 1 && number <= total).sort((a, b) => a - b);
  /** @type {(number | null)[]} */
  const result = [];
  for (const number of numbers) {
    const previous = result.at(-1);
    if (previous != null && number - previous > 1) {
      result.push(number - previous === 2 ? previous + 1 : null);
    }
    result.push(number);
  }
  return result;
}
