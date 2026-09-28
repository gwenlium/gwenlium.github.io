import { phoneViewport } from './window-layout';

const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
let disposeReading: (() => void) | undefined;

function disposeEntryReading(): void {
  disposeReading?.();
  disposeReading = undefined;
}

function initializeEntryReading(): void {
  const page = document.getElementById('page-scroll');
  const article = document.getElementById('entry-top');
  const content = document.getElementById('entry-content');
  const navigation = document.querySelector<HTMLElement>('[data-entry-navigation]');
  const progress = navigation?.querySelector<HTMLElement>('[data-entry-reading-progress]');
  const reader = article?.querySelector<HTMLElement>('[data-dialogue-reader]');
  disposeEntryReading();
  if (!page || !article || !content || !navigation || !progress || !reader) return;

  const controller = new AbortController();
  const options = { passive: true, signal: controller.signal };
  let frame = 0;
  let navigationHeight = -1;
  let previousValue = -1;
  let previousText = '';
  let printing = false;

  function update(): void {
    frame = 0;
    if (printing || !phoneViewport.matches) {
      progress!.hidden = true;
      return;
    }

    const height = navigation!.getBoundingClientRect().height;
    if (height !== navigationHeight) {
      navigationHeight = height;
      article!.style.setProperty('--entry-navigation-height', `${height}px`);
    }
    if (reader!.hasAttribute('data-dialogue-active')) {
      progress!.hidden = true;
      return;
    }
    const viewport = page!.getBoundingClientRect();
    const start = article!.getBoundingClientRect().top;
    const end = content!.getBoundingClientRect();
    if (!page!.clientHeight || !end.height) {
      progress!.hidden = true;
      return;
    }

    const readingTop = viewport.top + page!.clientTop + height;
    const readingBottom = viewport.top + page!.clientTop + page!.clientHeight;
    // The range ends when the last content reaches the viewport, never at the footer or pagination.
    const distance = end.bottom - start - (readingBottom - readingTop);
    const complete = end.bottom <= readingBottom + 1;
    const value = complete ? 100 : distance <= 1 ? 0
      : Math.min(99, Math.max(0, Math.floor((readingTop - start) / distance * 100)));
    const text = distance <= 1 && complete ? 'Entire entry is visible' : `${value}% through entry`;
    if (value !== previousValue) {
      previousValue = value;
      progress!.setAttribute('aria-valuenow', String(value));
      progress!.style.setProperty('--entry-reading-progress', String(value / 100));
    }
    if (text !== previousText) {
      previousText = text;
      progress!.setAttribute('aria-valuetext', text);
    }
    progress!.hidden = false;
  }

  function queueUpdate(): void {
    if (!frame) frame = requestAnimationFrame(update);
  }

  const resizeObserver = new ResizeObserver(queueUpdate);
  for (const element of [page, article, content, navigation]) resizeObserver.observe(element);
  const stateObserver = new MutationObserver(queueUpdate);
  stateObserver.observe(reader, { attributes: true, attributeFilter: ['data-dialogue-active'] });
  page.addEventListener('scroll', queueUpdate, options);
  window.addEventListener('resize', queueUpdate, options);
  window.visualViewport?.addEventListener('resize', queueUpdate, options);
  phoneViewport.addEventListener('change', queueUpdate, options);
  document.addEventListener('gwenlium:chrome-change', queueUpdate, options);
  window.addEventListener('beforeprint', () => { printing = true; progress.hidden = true; }, options);
  window.addEventListener('afterprint', () => { printing = false; queueUpdate(); }, options);

  disposeReading = () => {
    controller.abort();
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    stateObserver.disconnect();
    progress.hidden = true;
    article.style.removeProperty('--entry-navigation-height');
  };
  queueUpdate();
}

document.addEventListener('astro:page-load', initializeEntryReading, listenerOptions);
document.addEventListener('astro:before-swap', disposeEntryReading, listenerOptions);
document.addEventListener('gwenlium:entry-content-replaced', initializeEntryReading, listenerOptions);
window.addEventListener('pagehide', disposeEntryReading, listenerOptions);
window.addEventListener('pageshow', initializeEntryReading, listenerOptions);
initializeEntryReading();

if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  disposeEntryReading();
});
