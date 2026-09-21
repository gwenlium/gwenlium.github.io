import { matchesTopics, topicKey } from '../lib/topics.mjs';
let controller: AbortController | undefined;
function initialize() {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  document.querySelectorAll<HTMLElement>('[data-topic-catalogue]').forEach(root => {
    const select = root.querySelector<HTMLSelectElement>('[data-topic-select]');
    const reset = root.querySelector<HTMLButtonElement>('[data-topic-reset]');
    const status = root.querySelector<HTMLElement>('[data-topic-status]');
    const empty = root.querySelector<HTMLElement>('[data-topic-empty]');
    if (!select || !reset || !status || !empty) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-item-topics]')).map(element => ({ element, topics: JSON.parse(element.dataset.itemTopics || '[]') as string[] }));
    const types = root.querySelectorAll<HTMLButtonElement>('[data-gallery-filter]');
    let type = 'all';
    function apply(updateUrl = false) {
      let visible = 0;
      for (const { element, topics } of items) {
        element.hidden = !matchesTopics(topics, select!.value, element.dataset.galleryType || 'audio', type);
        if (!element.hidden) visible++;
        else element.querySelectorAll<HTMLVideoElement>('video').forEach(video => video.pause());
      }
      types.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.galleryFilter === type)));
      status!.textContent = `${visible} of ${items.length} ${root.dataset.topicCatalogue === 'music' ? 'tracks' : 'items'}`;
      empty!.hidden = visible > 0;
      reset!.hidden = !select!.value && type === 'all';
      if (updateUrl) {
        const url = new URL(location.href);
        if (select!.value) url.searchParams.set('topic', select!.value); else url.searchParams.delete('topic');
        if (type !== 'all') url.searchParams.set('type', type); else url.searchParams.delete('type');
        history.replaceState(history.state, '', url);
      }
    }
    function readUrl() {
      const params = new URLSearchParams(location.search);
      const topic = topicKey(params.get('topic') || '');
      select!.value = Array.from(select!.options).some(option => option.value === topic) ? topic : '';
      type = types.length && ['image', 'video'].includes(params.get('type') || '') ? params.get('type')! : 'all';
      apply();
      // A direct link to a particular artwork/track must remain visible.
      let target: HTMLElement | null = null;
      try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { /* Ignore malformed fragments. */ }
      if (target?.hidden && root.contains(target)) { select!.value = ''; type = 'all'; apply(true); }
    }
    select.addEventListener('change', () => apply(true), { signal });
    reset.addEventListener('click', () => { select.value = ''; type = 'all'; apply(true); }, { signal });
    types.forEach(button => button.addEventListener('click', () => { type = button.dataset.galleryFilter || 'all'; apply(true); }, { signal }));
    root.querySelectorAll<HTMLButtonElement>('[data-topic-pick]').forEach(button => button.addEventListener('click', () => { select.value = topicKey(button.dataset.topicPick || ''); apply(true); }, { signal }));
    window.addEventListener('popstate', readUrl, { signal });
    window.addEventListener('hashchange', readUrl, { signal });
    readUrl();
  });
}
document.addEventListener('astro:page-load', initialize);
document.addEventListener('astro:before-swap', () => controller?.abort());
initialize();
if (import.meta.hot) import.meta.hot.dispose(() => controller?.abort());
