/** @param {string} value */
export const topicKey = value => value.trim().toLocaleLowerCase('en');
/** @param {string[] | undefined} values */
export function normalizeTopics(values) {
  return [...new Map((values ?? []).map(value => value.trim()).filter(Boolean).map(value => [topicKey(value), value])).values()];
}
/** @param {{ topics: string[] }[]} items */
export function topicOptions(items) {
  return normalizeTopics(items.flatMap(item => item.topics)).sort((a, b) => a.localeCompare(b, 'en'));
}
/** @param {string[]} topics @param {string} topic @param {string} type @param {string} filterType */
export const matchesTopics = (topics, topic, type, filterType) => (!topic || topics.some(value => topicKey(value) === topicKey(topic))) && (filterType === 'all' || type === filterType);
