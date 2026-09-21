const interactionStyles = `
.media-zoom-trigger { display:block; width:100%; padding:0; border:0; background:transparent; color:inherit; cursor:zoom-in; text-align:inherit; }
.media-zoom-trigger picture, .media-zoom-trigger img { display:block; max-width:100%; }
.media-zoom-trigger:focus-visible { outline:3px solid var(--ink, #203a2e); outline-offset:5px; }
.media-dialog { width:min(1100px, 94vw); max-width:94vw; max-height:92dvh; padding:0; overflow:auto; border:2px solid var(--ink, #203a2e); background:var(--surface, #f5f1df); color:var(--ink, #203a2e); box-shadow:8px 8px 0 #10291a45; }
.media-dialog::backdrop { background:transparent; backdrop-filter:none; }
.media-dialog__bar { cursor:move; touch-action:none; user-select:none; display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.7rem 1rem; border-bottom:1px solid var(--line, #8a9b86); background:var(--sage, #b8c8a4); font-family:var(--font-ui, monospace); font-size:.75rem; }
.media-dialog__close { min-width:44px; min-height:44px; flex:none; padding:.35rem .6rem; border:1px solid var(--ink, #203a2e); background:var(--surface-raised, #fffbea); color:inherit; font:inherit; cursor:pointer; }
.media-dialog__close:focus-visible { outline:3px solid currentColor; outline-offset:3px; }
.media-dialog__content { margin:0; padding:1rem; }
.media-dialog__content img, .media-dialog__content video { display:block; width:100%; max-height:70dvh; object-fit:contain; }
.media-dialog__caption { margin-top:.8rem; font-family:var(--font-reading, sans-serif); line-height:1.6; white-space:pre-line; overflow-wrap:anywhere; }
.media-dialog__caption:empty { display:none; }
.media-dialog[open] { animation:media-window-open 220ms cubic-bezier(.2,.8,.2,1); }
@keyframes media-window-open { from { opacity:0; transform:translateY(12px) scale(.97); } to { opacity:1; transform:translateY(0) scale(1); } }
@media (max-width:600px) { .media-dialog { width:96vw; max-width:96vw; max-height:88dvh; } .media-dialog__content { padding:.5rem; } .media-dialog__bar { padding:.4rem .6rem; } .media-dialog__content img, .media-dialog__content video { max-height:68dvh; } }
@media (prefers-reduced-motion:reduce) { .media-dialog[open] { animation:none; } }
.media-dialog__error { padding:1rem; font-family:var(--font-reading, sans-serif); }
`;

let pageController: AbortController | undefined;
let videoObserver: IntersectionObserver | undefined;
let lightbox: HTMLDialogElement | undefined;
let lightboxTrigger: HTMLElement | undefined;
let previousOverflow = '';

function dismissLightbox(restoreFocus = true) {
  if (!lightbox) return;
  lightbox.querySelector('video')?.pause();
  if (lightbox.open) lightbox.close();
  lightbox.remove();
  lightbox = undefined;
  document.documentElement.style.overflow = previousOverflow;
  if (restoreFocus && lightboxTrigger?.isConnected) lightboxTrigger.focus({ preventScroll: true });
  lightboxTrigger = undefined;
}

function openLightbox(trigger: HTMLElement, source: string, kind: 'image' | 'video', alt: string, caption: string, poster = '') {
  dismissLightbox(false);
  lightboxTrigger = trigger;
  const dialog = document.createElement('dialog');
  dialog.className = 'media-dialog';
  dialog.setAttribute('aria-label', kind === 'image' ? 'Image viewer' : 'Video viewer');
  dialog.innerHTML = '<div class="media-dialog__bar"><span>MEDIA VIEWER</span><button type="button" class="media-dialog__close" aria-label="Close media viewer">Close ×</button></div><figure class="media-dialog__content"><figcaption class="media-dialog__caption" id="media-viewer-caption"></figcaption></figure>';
  const figure = dialog.querySelector('figure')!;
  const description = dialog.querySelector('figcaption')!;
  description.textContent = caption;
  if (caption) dialog.setAttribute('aria-describedby', description.id);

  const media = document.createElement(kind === 'video' ? 'video' : 'img');
  media.src = source;
  if (media instanceof HTMLImageElement) {
    media.alt = alt;
    media.decoding = 'async';
  } else {
    media.controls = true;
    media.playsInline = true;
    media.preload = 'metadata';
    media.poster = poster;
    media.setAttribute('aria-label', alt || caption || 'Video');
    // Opening the viewer never starts playback by itself.
    document.querySelectorAll<HTMLVideoElement>('video').forEach((video) => video.pause());
  }
  media.addEventListener('error', () => {
    const error = document.createElement('p');
    error.className = 'media-dialog__error';
    error.setAttribute('role', 'status');
    error.textContent = 'This media could not be loaded. ';
    const link = document.createElement('a');
    link.href = source;
    link.textContent = 'Open the media preview';
    error.append(link);
    media.replaceWith(error);
  }, { once: true });
  figure.prepend(media);
  document.body.append(dialog);
  lightbox = dialog;
  previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  dialog.querySelector('button')!.addEventListener('click', () => dismissLightbox());
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismissLightbox();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismissLightbox();
  });
  const bar = dialog.querySelector<HTMLElement>('.media-dialog__bar')!;
  let drag: { x: number; y: number; left: number; top: number } | undefined;
  bar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const rect = dialog.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    bar.setPointerCapture(event.pointerId);
  });
  bar.addEventListener('pointermove', event => {
    if (!drag) return;
    dialog.style.position = 'fixed';
    dialog.style.margin = '0';
    dialog.style.left = `${Math.max(0, Math.min(innerWidth - dialog.offsetWidth, drag.left + event.clientX - drag.x))}px`;
    dialog.style.top = `${Math.max(0, Math.min(innerHeight - bar.offsetHeight, drag.top + event.clientY - drag.y))}px`;
  });
  bar.addEventListener('pointerup', () => { drag = undefined; });
  bar.addEventListener('pointercancel', () => { drag = undefined; });
  dialog.showModal();
  dialog.querySelector('button')!.focus();
}

function initializeMedia() {
  pageController?.abort();
  videoObserver?.disconnect();
  const controller = new AbortController();
  pageController = controller;
  const { signal } = controller;

  if (!document.getElementById('media-interaction-styles')) {
    const style = document.createElement('style');
    style.id = 'media-interaction-styles';
    style.textContent = interactionStyles;
    document.head.append(style);
  }

  document.querySelectorAll<HTMLImageElement>('img[data-zoom]').forEach((image) => {
    // Authored links are navigation, not lightbox controls.
    if (image.closest('a, button')) return;
    const target = image.parentElement?.tagName === 'PICTURE' ? image.parentElement : image;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'media-zoom-trigger';
    button.dataset.mediaZoom = '';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', image.alt ? `Expand image: ${image.alt}` : 'Expand image');
    target.replaceWith(button);
    button.append(target);
  });

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const imageButton = event.target.closest<HTMLButtonElement>('[data-media-zoom]');
    if (imageButton) {
      const image = imageButton.querySelector<HTMLImageElement>('img');
      if (!image) return;
      const caption = image.dataset.zoomCaption || image.closest('figure')?.querySelector('figcaption')?.textContent || '';
      openLightbox(imageButton, image.dataset.zoomSrc || image.dataset.fullSrc || image.currentSrc || image.src, 'image', image.alt, caption);
      return;
    }
    const videoButton = event.target.closest<HTMLButtonElement>('[data-zoom-video]');
    if (videoButton?.dataset.zoomVideo) {
      openLightbox(videoButton, videoButton.dataset.zoomVideo, 'video', videoButton.dataset.zoomAlt || '', videoButton.dataset.zoomCaption || '', videoButton.dataset.zoomPoster || '');
    }
  }, { signal });

  const videos = document.querySelectorAll<HTMLVideoElement>('video:not(.media-dialog video)');
  if ('IntersectionObserver' in window) {
    videoObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) if (!entry.isIntersecting) (entry.target as HTMLVideoElement).pause();
    }, { threshold: 0 });
    videos.forEach((video) => videoObserver!.observe(video));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) document.querySelectorAll('video').forEach((video) => video.pause());
  }, { signal });

  document.querySelectorAll<HTMLButtonElement>('[data-copy-feed]').forEach((button) => {
    button.addEventListener('click', async () => {
      const url = button.dataset.copyFeed;
      const status = button.parentElement?.querySelector<HTMLElement>('[data-copy-status]');
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        if (!signal.aborted && status) status.textContent = 'Feed address copied.';
      } catch {
        if (!signal.aborted && status) status.textContent = 'Clipboard access is unavailable. Select and copy the feed address below.';
        const input = document.querySelector<HTMLInputElement>('[data-feed-address]');
        if (!signal.aborted && input) { input.focus(); input.select(); }
      }
    }, { signal });
  });
}

function beforePageSwap() {
  dismissLightbox(false);
  pageController?.abort();
  videoObserver?.disconnect();
  document.querySelectorAll('video').forEach((video) => video.pause());
}

document.addEventListener('astro:before-swap', beforePageSwap);
document.addEventListener('astro:page-load', initializeMedia);
initializeMedia();
