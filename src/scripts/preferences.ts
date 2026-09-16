type ThemePreference = 'light' | 'dark' | 'system';
type MotionPreference = 'full' | 'reduced' | 'system';
type ReadingPreference = 'pixel' | 'readable';
type BackgroundPreference = 'auto' | 'dots' | 'polygons' | 'circuits' | 'checker' | 'wave' | 'off';

const backgroundOptions: Record<string, BackgroundPreference | undefined> = {
  auto: 'auto', dots: 'dots', polygons: 'polygons', circuits: 'circuits', checker: 'checker', wave: 'wave', off: 'off',
};

type Preferences = {
  theme: ThemePreference;
  motion: MotionPreference;
  reading: ReadingPreference;
  background: BackgroundPreference;
};

type BeforeSwapEvent = Event & { newDocument: Document };

const storageKey = 'gwenlium:preferences';
const defaults: Preferences = { theme: 'system', motion: 'system', reading: 'readable', background: 'auto' };
// The first-paint script chooses once; this value survives all ClientRouter swaps.
const autoBackground = document.documentElement.dataset.backgroundAuto || 'dots';
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
let storageAvailable = true;
let returnFocus: HTMLElement | null = null;
let observedNavigation: HTMLElement | null = null;
const navigationObserver = new ResizeObserver(updateNavigationOffset);

function updateNavigationOffset(): void {
  const height = window.innerWidth <= 760 ? (observedNavigation?.getBoundingClientRect().height ?? 0) + 24 : 24;
  document.documentElement.style.setProperty('--navigation-offset', `${height}px`);
}

function trackNavigation(): void {
  const navigation = document.querySelector<HTMLElement>('.site-rail');
  if (navigation !== observedNavigation) {
    navigationObserver.disconnect();
    observedNavigation = navigation;
    if (navigation) navigationObserver.observe(navigation);
  }
  updateNavigationOffset();
}

function readPreferences(fallback: Preferences): Preferences {
  let stored: string | null;
  try {
    stored = localStorage.getItem(storageKey);
    storageAvailable = true;
  } catch {
    storageAvailable = false;
    return { ...fallback };
  }

  let saved: unknown;
  try {
    saved = JSON.parse(stored || '{}');
  } catch {
    return { ...defaults };
  }
  if (!saved || typeof saved !== 'object') return { ...defaults };
  const value = saved as Record<string, unknown>;
  return {
    theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system',
    motion: value.motion === 'full' || value.motion === 'reduced' ? value.motion : 'system',
    reading: value.reading === 'pixel' ? 'pixel' : 'readable',
    background: typeof value.background === 'string' && Object.hasOwn(backgroundOptions, value.background)
      ? backgroundOptions[value.background] ?? 'auto'
      : 'auto',
  };
}

let preferences = readPreferences(defaults);

function applyPreferences(root: HTMLElement = document.documentElement): void {
  root.dataset.themePreference = preferences.theme;
  root.dataset.motionPreference = preferences.motion;
  root.dataset.theme = preferences.theme === 'system'
    ? (darkScheme.matches ? 'dark' : 'light')
    : preferences.theme;
  root.dataset.motion = preferences.motion === 'system'
    ? (reducedMotion.matches ? 'reduced' : 'full')
    : preferences.motion;
  root.dataset.reading = preferences.reading;
  root.dataset.background = preferences.background;
  root.dataset.backgroundAuto = autoBackground;
  root.dataset.backgroundActive = preferences.background === 'auto' ? autoBackground : preferences.background;
  root.style.colorScheme = root.dataset.theme;
}

function syncControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[data-preference]').forEach((input) => {
    const key = input.dataset.preference;
    if (key === 'theme' || key === 'motion' || key === 'reading' || key === 'background') {
      input.checked = input.value === preferences[key];
    }
  });
  if (!storageAvailable) updateStatus();
}

function updateStatus(): void {
  const status = document.querySelector<HTMLElement>('[data-preferences-status]');
  if (status) {
    status.textContent = storageAvailable
      ? 'Preferences saved on this device.'
      : 'Applied for this visit. Browser storage is unavailable.';
  }
}

// Astro runs bundled scripts once; delegated listeners also cover swapped pages.
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const opener = event.target.closest<HTMLButtonElement>('[data-open-settings]');
  const dialog = document.querySelector<HTMLDialogElement>('#site-settings');
  if (!dialog) return;

  if (opener) {
    syncControls();
    returnFocus = opener;
    if (!dialog.open) dialog.showModal();
    return;
  }

  if (event.target.closest('[data-close-settings]')) {
    dialog.close();
    return;
  }

  if (event.target === dialog && event instanceof MouseEvent) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      dialog.close();
    }
  }
}, listenerOptions);

document.addEventListener('close', (event) => {
  if (!(event.target instanceof HTMLDialogElement) || event.target.id !== 'site-settings') return;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}, { ...listenerOptions, capture: true });

document.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches('input[data-preference]')) return;
  const key = input.dataset.preference;
  const value = input.value;
  if (key === 'theme' && (value === 'light' || value === 'dark' || value === 'system')) {
    preferences.theme = value;
  } else if (key === 'motion' && (value === 'full' || value === 'reduced' || value === 'system')) {
    preferences.motion = value;
  } else if (key === 'reading' && (value === 'pixel' || value === 'readable')) {
    preferences.reading = value;
  } else if (key === 'background' && Object.hasOwn(backgroundOptions, value)) {
    preferences.background = backgroundOptions[value] ?? 'auto';
  } else {
    return;
  }

  applyPreferences();
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
    if (preferences.background === 'auto') localStorage.setItem('gwenlium:background:last-auto', autoBackground);
    storageAvailable = true;
  } catch {
    storageAvailable = false;
  }
  updateStatus();
}, listenerOptions);

document.addEventListener('astro:before-swap', (event) => {
  applyPreferences((event as BeforeSwapEvent).newDocument.documentElement);
  const dialog = document.querySelector<HTMLDialogElement>('#site-settings');
  if (dialog?.open) dialog.close();
}, listenerOptions);

document.addEventListener('astro:page-load', () => {
  applyPreferences();
  syncControls();
  trackNavigation();
}, listenerOptions);

darkScheme.addEventListener('change', () => applyPreferences(), listenerOptions);
reducedMotion.addEventListener('change', () => applyPreferences(), listenerOptions);
window.addEventListener('resize', updateNavigationOffset, listenerOptions);
window.addEventListener('storage', (event) => {
  if (event.key !== storageKey && event.key !== null) return;
  preferences = readPreferences(preferences);
  applyPreferences();
  syncControls();
}, listenerOptions);

applyPreferences();
syncControls();
trackNavigation();

if (import.meta.hot) import.meta.hot.dispose(() => { lifetime.abort(); navigationObserver.disconnect(); });

export {};
