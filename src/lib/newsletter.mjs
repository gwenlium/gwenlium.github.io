export const newsletterUrlError = 'Use the public HTTPS form URL from Brevo (https://…sibforms.com/serve/…), or leave it empty to disable email signup.';

/** The existing window switches also control whether the subscriptions page is public.
 * @param {Array<{page: string, enabled: boolean}>} windows
 */
export function subscriptionsEnabled(windows) {
  return windows.some(window => window.page === 'subscribe' && window.enabled);
}

/**
 * One allowlist for the renderer, build validator and generated security policy.
 * @param {unknown} value
 * @returns {string}
 */
export function brevoFormUrl(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new Error(newsletterUrlError);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(?:[a-z0-9-]+\.)?sibforms\.com$/.test(url.hostname) ||
        !/^\/(?:v2\/)?serve\/[A-Za-z0-9_-]+={0,2}$/.test(url.pathname) || url.search || url.hash) throw new Error();
    return url.href;
  } catch { throw new Error(newsletterUrlError); }
}
