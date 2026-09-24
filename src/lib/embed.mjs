/**
 * YouTube and Vimeo addresses to their privacy-friendly embed players. Shared by the game
 * trailer, entry text (a link alone in a paragraph) and the editor's previews.
 * @param {string} value
 * @param {string | URL} [base]
 * @returns {string | undefined}
 */
export function videoEmbed(value, base = 'https://gwenlium.dev') {
  let url;
  try { url = new URL(value, base); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const youtubeHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'];
  const youtubeId = url.hostname === 'youtu.be'
    ? url.pathname.slice(1)
    : youtubeHosts.includes(url.hostname)
      ? url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1]
      : '';
  if (youtubeId && /^[\w-]{11}$/.test(youtubeId)) return `https://www.youtube-nocookie.com/embed/${youtubeId}`;
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(url.hostname)) {
    const id = url.pathname.match(/^\/(?:video\/)?(\d+)(?:\/|$)/)?.[1];
    if (id) return `https://player.vimeo.com/video/${id}?dnt=1`;
  }
  return undefined;
}

/** Prepared video and audio files use the picture syntax in text; this tells them apart. */
export function mediaKindOf(src) {
  return /\.mp4(?:[?#]|$)/i.test(src) ? 'video' : /\.mp3(?:[?#]|$)/i.test(src) ? 'audio' : 'image';
}
