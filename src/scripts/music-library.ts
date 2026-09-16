import { navigate } from 'astro:transitions/client';

type Reaction = 'like' | 'dislike';
type Track = { id: string; title: string; src: string };
type Playlist = { id: string; name: string; ids: string[] };
type LibraryState = { v: 1; playlists: Playlist[]; selectedId: string | null; reactions: Record<string, Reaction> };
type SharedPlaylist = { name: string; ids: string[]; missing: number; duplicates: number; savedId: string | null };
type StoredLibrary = { v?: unknown; playlists?: unknown; selectedId?: unknown; reactions?: unknown };
type StoredPlaylist = { id?: unknown; name?: unknown; ids?: unknown };
type SharedPayload = { v?: unknown; name?: unknown; ids?: unknown };

const STORAGE_KEY = 'gwenlium:music-library:v1';
const MAX_PLAYLISTS = 50;
const MAX_TRACKS = 100;
const MAX_NAME = 80;
const MAX_ID = 128;
const MAX_REACTIONS = 1000;
const MAX_STORAGE_LENGTH = 2_000_000;
const MAX_LINK_LENGTH = 16_000;
const MAX_SHARE_LENGTH = 14_000;
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
let storageAvailable = true;
let storageNotice = '';
let library: HTMLElement | null = null;
let pendingTrackId: string | null = null;
let pendingTargetId = '';
let deleteId: string | null = null;
let shared: SharedPlaylist | null = null;
let shareDialog: HTMLDialogElement | null = null;
let pageVersion = 0;
let catalogue = new Map<string, Track>();

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && !/[\u0000-\u001f\u007f]/u.test(value);
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_NAME * 2) return null;
  const name = value.trim().normalize('NFC');
  return name && Array.from(name).length <= MAX_NAME && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

function readState(): LibraryState {
  const result: LibraryState = { v: 1, playlists: [], selectedId: null, reactions: Object.create(null) as Record<string, Reaction> };
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    storageAvailable = false;
    return result;
  }
  if (!raw) return result;
  try {
    if (raw.length > MAX_STORAGE_LENGTH) throw new Error('Library exceeds storage limit');
    const saved = JSON.parse(raw) as StoredLibrary | null;
    if (!saved || typeof saved !== 'object' || saved.v !== 1 || !Array.isArray(saved.playlists) || !saved.reactions || typeof saved.reactions !== 'object' || Array.isArray(saved.reactions)) {
      throw new Error('Unknown library format');
    }
    let repaired = saved.playlists.length > MAX_PLAYLISTS;
    const seen = new Set<string>();
    for (const value of saved.playlists.slice(0, MAX_PLAYLISTS)) {
      const entry = value as StoredPlaylist | null;
      if (!entry || typeof entry !== 'object' || !validId(entry.id) || seen.has(entry.id) || !Array.isArray(entry.ids)) {
        repaired = true;
        continue;
      }
      const name = cleanName(entry.name);
      if (!name) { repaired = true; continue; }
      seen.add(entry.id);
      const ids: string[] = [];
      const trackIds = new Set<string>();
      if (entry.ids.length > MAX_TRACKS) repaired = true;
      for (const id of entry.ids.slice(0, MAX_TRACKS)) {
        if (!validId(id) || trackIds.has(id)) { repaired = true; continue; }
        trackIds.add(id);
        ids.push(id);
      }
      result.playlists.push({ id: entry.id, name, ids });
    }
    let reactionCount = 0;
    for (const [id, reaction] of Object.entries(saved.reactions)) {
      if (!validId(id) || !catalogue.has(id) || (reaction !== 'like' && reaction !== 'dislike') || reactionCount >= MAX_REACTIONS) {
        repaired = true;
        continue;
      }
      result.reactions[id] = reaction;
      reactionCount++;
    }
    result.selectedId = typeof saved.selectedId === 'string' && seen.has(saved.selectedId)
      ? saved.selectedId : result.playlists[0]?.id ?? null;
    if (repaired) storageNotice = 'Some invalid or over-limit saved entries were ignored. Valid playlists and reactions are still available.';
    return result;
  } catch {
    storageNotice = 'The saved music library could not be read. Starting empty; your next change will replace the unreadable saved data.';
    return result;
  }
}

readCatalogue();
const state = readState();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageAvailable = true;
    storageNotice = '';
  } catch {
    storageAvailable = false;
  }
  updateStorageStatus();
}

function updateStorageStatus(): void {
  const status = library?.querySelector<HTMLElement>('[data-library-storage]');
  if (status) status.textContent = storageAvailable
    ? ['Playlists and reactions save in this browser on this device, not to an account. There are no public reaction counts.', storageNotice].filter(Boolean).join(' ')
    : 'Browser storage is unavailable or full. Changes work in memory for this visit, including page navigation, but will be lost when you reload or leave the site.';
}

function announce(message: string): void {
  const text = storageAvailable ? message : `${message} Changes are only in memory for this visit; browser storage is unavailable or full.`;
  document.querySelectorAll<HTMLElement>('[data-library-status], [data-music-feedback]').forEach((status) => { status.textContent = text; });
}

function readCatalogue(): void {
  catalogue = new Map();
  const host = document.querySelector<HTMLElement>('gwenlium-player[data-tracks]');
  try {
    const tracks: unknown = JSON.parse(host?.dataset.tracks || '[]');
    if (!Array.isArray(tracks)) return;
    for (const value of tracks) {
      const track = value as Partial<Track> | null;
      if (!track || typeof track !== 'object' || !validId(track.id) || catalogue.has(track.id)) continue;
      catalogue.set(track.id, {
        id: track.id,
        title: typeof track.title === 'string' && track.title.trim() ? track.title : 'Untitled track',
        src: typeof track.src === 'string' ? track.src : '',
      });
    }
  } catch { /* A missing catalogue leaves personal lists readable, but disables track actions. */ }
}

function trackIdFor(control: HTMLElement): string {
  return control.dataset.trackId || control.closest<HTMLElement>('gwenlium-player')?.dataset.currentTrack || '';
}

function syncTrackControls(): void {
  document.querySelectorAll<HTMLButtonElement>('button[data-track-reaction]').forEach((button) => {
    const id = trackIdFor(button);
    button.disabled = !catalogue.has(id);
    button.setAttribute('aria-pressed', String(catalogue.has(id) && state.reactions[id] === button.dataset.trackReaction));
  });
  document.querySelectorAll<HTMLButtonElement>('button[data-share-track], button[data-add-current-track], button[data-add-track]').forEach((button) => {
    button.disabled = !catalogue.has(trackIdFor(button));
  });
}

function selectedPlaylist(): Playlist | undefined {
  return state.playlists.find((playlist) => playlist.id === state.selectedId);
}

function setText(selector: string, text: string): void {
  const node = library?.querySelector<HTMLElement>(selector);
  if (node) node.textContent = text;
}

function option(value: string, text: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = text;
  return node;
}

function renderTracks(list: HTMLOListElement, ids: string[], source: 'personal' | 'shared'): void {
  const rows = document.createDocumentFragment();
  ids.forEach((id, index) => {
    const track = catalogue.get(id);
    const title = track?.title || `Unavailable track (${id})`;
    const row = document.createElement('li');
    row.className = 'playlist-track';
    const number = document.createElement('span');
    number.className = 'playlist-track__number';
    number.textContent = String(index + 1).padStart(2, '0');
    number.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'playlist-track__title';
    label.textContent = track && !track.src ? `${title} — audio unavailable` : title;
    const actions = document.createElement('div');
    actions.className = 'playlist-track__actions';
    const addButton = (action: string, text: string, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button-secondary';
      button.textContent = text;
      button.dataset.playlistTrackAction = action;
      button.dataset.trackId = id;
      button.dataset.listSource = source;
      button.disabled = disabled;
      button.setAttribute('aria-label', `${text}: ${title}`);
      actions.append(button);
    };
    addButton('play', 'Play', !track?.src);
    if (source === 'personal') {
      addButton('up', 'Move up', index === 0);
      addButton('down', 'Move down', index === ids.length - 1);
      addButton('remove', 'Remove');
    }
    row.append(number, label, actions);
    rows.append(row);
  });
  list.replaceChildren(rows);
}

function renderLibrary(): void {
  if (!library) return;
  library.querySelector<HTMLFieldSetElement>('[data-library-controls]')!.disabled = false;
  library.querySelector<HTMLButtonElement>('[data-create-button]')!.disabled = state.playlists.length >= MAX_PLAYLISTS;
  setText('[data-playlist-capacity]', `${state.playlists.length} / ${MAX_PLAYLISTS} playlists`);
  updateStorageStatus();

  const selection = library.querySelector<HTMLSelectElement>('[data-playlist-select]')!;
  const destination = library.querySelector<HTMLSelectElement>('[data-add-target]')!;
  selection.replaceChildren();
  destination.replaceChildren(option('', 'Choose a playlist'));
  state.playlists.forEach((playlist, index) => {
    const title = `${index + 1}. ${playlist.name} — ${playlist.ids.length} ${playlist.ids.length === 1 ? 'track' : 'tracks'}`;
    selection.append(option(playlist.id, title));
    destination.append(option(playlist.id, title));
  });
  selection.value = state.selectedId || '';
  if (!state.playlists.some((playlist) => playlist.id === pendingTargetId)) pendingTargetId = '';
  destination.value = pendingTargetId;
  destination.disabled = !state.playlists.length;
  library.querySelector<HTMLButtonElement>('[data-confirm-add]')!.disabled = !pendingTargetId;
  library.querySelector<HTMLElement>('[data-add-panel]')!.hidden = !pendingTrackId;
  if (pendingTrackId) setText('[data-add-description]', `Choose where to add “${catalogue.get(pendingTrackId)?.title || 'Unavailable track'}”.`);

  const playlist = selectedPlaylist();
  library.querySelector<HTMLElement>('[data-no-playlists]')!.hidden = state.playlists.length > 0;
  library.querySelector<HTMLElement>('[data-playlist-manager]')!.hidden = !playlist;
  if (playlist) {
    setText('[data-selected-name]', playlist.name);
    setText('[data-selected-count]', `${playlist.ids.length} / ${MAX_TRACKS} tracks`);
    library.querySelector<HTMLInputElement>('#playlist-rename-name')!.value = playlist.name;
    library.querySelector<HTMLInputElement>('#playlist-rename-name')!.setCustomValidity('');
    const playable = playlist.ids.filter((id) => catalogue.get(id)?.src).length;
    const missing = playlist.ids.filter((id) => !catalogue.has(id)).length;
    const unavailable = playlist.ids.length - playable - missing;
    setText('[data-playlist-note]', playlist.ids.length
      ? [`Use Move up and Move down to choose playback order. ${playable} playable ${playable === 1 ? 'track' : 'tracks'}.`, missing ? `${missing} removed or unknown ${missing === 1 ? 'track is' : 'tracks are'} kept here so you can remove them; playback and sharing skip them.` : '', unavailable ? `${unavailable} ${unavailable === 1 ? 'track has' : 'tracks have'} no audio and will be skipped during playback.` : ''].filter(Boolean).join(' ')
      : catalogue.size ? 'This playlist is empty. Use Add beside a catalogue track below, then choose this playlist as its destination.' : 'This playlist is empty. You can name and share it now; add music here when tracks are published.');
    library.querySelector<HTMLButtonElement>('[data-library-action="play-playlist"]')!.disabled = playable === 0;
    library.querySelector<HTMLElement>('[data-delete-confirm]')!.hidden = deleteId !== playlist.id;
    setText('[data-delete-description]', `Delete “${playlist.name}” from this device? Shared links and other saved copies are not affected.`);
    renderTracks(library.querySelector<HTMLOListElement>('[data-playlist-tracks]')!, playlist.ids, 'personal');
  }

  library.querySelector<HTMLElement>('[data-shared-preview]')!.hidden = !shared;
  if (shared) {
    setText('[data-shared-label]', shared.savedId ? 'Shared preview / personal copy added' : 'Shared preview / not saved');
    setText('[data-shared-name]', shared.name);
    const playable = shared.ids.filter((id) => catalogue.get(id)?.src).length;
    setText('[data-shared-note]', [
      shared.savedId ? 'A separate copy was added to your personal library. Editing it does not change this preview or the link.' : 'Preview only. Your personal playlists have not been changed. Save copy imports this list on this device.',
      `${shared.ids.length} known ${shared.ids.length === 1 ? 'track' : 'tracks'}; ${playable} playable.`,
      shared.missing ? `${shared.missing} unknown or removed ${shared.missing === 1 ? 'track was' : 'tracks were'} omitted.` : '',
      shared.duplicates ? `${shared.duplicates} duplicate ${shared.duplicates === 1 ? 'entry was' : 'entries were'} ignored.` : '',
      !shared.ids.length ? 'There are no known tracks in this shared playlist; you can still save an empty copy.' : 'Playback skips tracks without audio.',
      !shared.savedId && state.playlists.length >= MAX_PLAYLISTS ? `Your library has ${MAX_PLAYLISTS} playlists. Delete one before saving this preview.` : '',
    ].filter(Boolean).join(' '));
    const save = library.querySelector<HTMLButtonElement>('[data-library-action="save-shared"]')!;
    save.disabled = Boolean(shared.savedId) || state.playlists.length >= MAX_PLAYLISTS;
    save.textContent = shared.savedId ? (storageAvailable ? 'Copy saved' : 'Copy added for this visit') : 'Save copy to this device';
    library.querySelector<HTMLButtonElement>('[data-library-action="play-shared"]')!.disabled = playable === 0;
    renderTracks(library.querySelector<HTMLOListElement>('[data-shared-tracks]')!, shared.ids, 'shared');
  }
}

function commit(message: string): void {
  persist();
  renderLibrary();
  syncTrackControls();
  announce(message);
}

function createPlaylist(name: string, ids: string[] = []): Playlist | null {
  if (state.playlists.length >= MAX_PLAYLISTS) {
    announce(`You have reached ${MAX_PLAYLISTS} playlists. Delete a playlist before creating or saving another.`);
    return null;
  }
  let id: string;
  do {
    id = globalThis.crypto?.randomUUID?.() || `playlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  } while (state.playlists.some((playlist) => playlist.id === id));
  const playlist = { id, name, ids: [...ids] };
  state.playlists.push(playlist);
  state.selectedId = id;
  deleteId = null;
  return playlist;
}

function beginAdd(id: string): void {
  if (!catalogue.has(id)) { announce('This track is not in the published catalogue anymore. Nothing was added.'); return; }
  if (!library) {
    const url = new URL('/music/', location.origin);
    url.searchParams.set('add', id);
    void navigate(`${url.pathname}${url.search}`);
    return;
  }
  pendingTrackId = id;
  pendingTargetId = '';
  renderLibrary();
  document.dispatchEvent(new CustomEvent('gwenlium:window-command', { detail: { id: 'music-library', action: 'restore' } }));
  const destination = library.querySelector<HTMLSelectElement>('[data-add-target]')!;
  (destination.disabled ? library.querySelector<HTMLInputElement>('#playlist-create-name') : destination)?.focus();
  library.querySelector('[data-add-panel]')?.scrollIntoView({ block: 'nearest' });
  announce('Choose a destination playlist, or create one, then press Add track to confirm.');
}

function playPlaylist(ids: string[], startId?: string): void {
  const playable = ids.filter((id) => catalogue.get(id)?.src);
  if (!playable.length) { announce('This playlist has no playable tracks.'); return; }
  document.dispatchEvent(new CustomEvent('gwenlium:playlist-play', { detail: { ids: playable, startId: startId && playable.includes(startId) ? startId : playable[0] } }));
  announce('Playlist order sent to the Music player. Playback requested; next and previous follow this order.');
}

function shareUrl(name: string, ids: string[]): string | null {
  const url = new URL('/music/', location.origin);
  const payload = JSON.stringify({ v: 1, name, ids });
  if (payload.length > MAX_SHARE_LENGTH) return null;
  url.searchParams.set('playlist', payload);
  return url.href.length <= MAX_LINK_LENGTH ? url.href : null;
}

function showCopyDialog(url: string, title: string): void {
  shareDialog?.close();
  const dialog = document.createElement('dialog');
  shareDialog = dialog;
  dialog.className = 'window window--lavender';
  Object.assign(dialog.style, { position: 'fixed', width: 'min(34rem, calc(100vw - 2rem))', maxHeight: 'calc(100dvh - 2rem)', margin: 'auto', color: 'var(--ink)', overflow: 'auto' });
  dialog.setAttribute('aria-labelledby', 'music-share-title');
  const bar = document.createElement('div');
  bar.className = 'window-titlebar';
  const heading = document.createElement('h2');
  heading.id = 'music-share-title';
  heading.className = 'window-titlebar__title';
  heading.textContent = 'Copy music link';
  bar.append(heading);
  const body = document.createElement('div');
  body.className = 'window-body';
  const description = document.createElement('p');
  description.className = 'settings-note';
  description.textContent = `Share “${title}”. Automatic sharing is unavailable; copy this link with your browser’s Copy command, then paste it wherever you like.`;
  const label = document.createElement('label');
  label.htmlFor = 'music-share-link';
  label.textContent = 'Shareable link';
  const input = document.createElement('input');
  input.id = 'music-share-link';
  input.type = 'url';
  input.readOnly = true;
  input.value = url;
  Object.assign(input.style, { display: 'block', width: '100%', marginBlock: '.65rem 1rem' });
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'The link is selected. Use Copy (Ctrl+C / Command+C), or touch and hold to copy.';
  const actions = document.createElement('div');
  actions.className = 'settings-bottom';
  actions.style.flexWrap = 'wrap';
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'button-secondary';
  select.textContent = 'Select link';
  select.addEventListener('click', () => { input.focus(); input.select(); });
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'button';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      status.textContent = 'Link copied. You can paste it wherever you like.';
    } catch {
      input.focus();
      input.select();
      status.textContent = 'Automatic copying is unavailable. Use your browser’s Copy command on the selected link (Ctrl+C / Command+C), or touch and hold to copy.';
    }
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'button-secondary';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (shareDialog === dialog) shareDialog = null;
  }, { once: true });
  actions.append(select, copy, close);
  body.append(description, label, input, status, actions);
  dialog.append(bar, body);
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  input.select();
}

async function shareLink(url: string, title: string, note = ''): Promise<void> {
  const version = pageVersion;
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      if (version === pageVersion) announce(['Share action completed.', note].filter(Boolean).join(' '));
      return;
    } catch (error) {
      if (version !== pageVersion) return;
      if (error instanceof Error && error.name === 'AbortError') { announce('Sharing cancelled.'); return; }
    }
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(url);
    if (version === pageVersion) announce(['Link copied. Paste it wherever you like.', note].filter(Boolean).join(' '));
  } catch {
    if (version !== pageVersion) return;
    announce(['Copy the link in the sharing dialog.', note].filter(Boolean).join(' '));
    showCopyDialog(url, title);
  }
}

function parseShared(value: string): SharedPlaylist | null {
  try {
    if (!value || value.length > MAX_SHARE_LENGTH) return null;
    const payload = JSON.parse(value) as SharedPayload | null;
    if (!payload || typeof payload !== 'object' || payload.v !== 1 || !Array.isArray(payload.ids) || payload.ids.length > MAX_TRACKS) return null;
    const name = cleanName(payload.name);
    if (!name || !payload.ids.every(validId)) return null;
    const unique = [...new Set(payload.ids as string[])];
    const ids = unique.filter((id) => catalogue.has(id));
    return { name, ids, missing: unique.length - ids.length, duplicates: payload.ids.length - unique.length, savedId: null };
  } catch {
    return null;
  }
}

function readPageLink(): void {
  if (!library) return;
  shared = null;
  pendingTrackId = null;
  pendingTargetId = '';
  deleteId = null;
  const url = new URL(location.href);
  const messages: string[] = [];
  if (url.href.length > MAX_LINK_LENGTH) {
    announce(`This music link exceeds the ${MAX_LINK_LENGTH.toLocaleString('en-US')}-character limit and was not opened. Your library is unchanged.`);
    return;
  }
  const playlistLinks = url.searchParams.getAll('playlist');
  if (playlistLinks.length) {
    shared = playlistLinks.length === 1 ? parseShared(playlistLinks[0]) : null;
    messages.push(shared ? 'Shared playlist opened as a preview. Save a copy only if you want it in your personal library.' : 'This playlist link is malformed, over the playlist limits, or uses an unsupported version. Your personal library is unchanged.');
  }
  const trackLinks = url.searchParams.getAll('track');
  if (trackLinks.length) {
    const track = trackLinks.length === 1 ? catalogue.get(trackLinks[0]) : undefined;
    if (track) {
      messages.push(`Shared track: “${track.title}”. ${track.src ? 'Press Play when you are ready; links do not autoplay.' : 'Its audio is currently unavailable.'}`);
      document.querySelectorAll<HTMLElement>('[data-track-row]').forEach((row) => {
        if (row.dataset.trackId === track.id) row.dataset.sharedTrack = 'true';
      });
    } else messages.push('This track link is invalid, or the track is no longer published.');
  }
  const addLinks = url.searchParams.getAll('add');
  if (addLinks.length) {
    const id = addLinks.length === 1 ? addLinks[0] : '';
    if (catalogue.has(id)) {
      pendingTrackId = id;
      messages.push('Choose a destination playlist, or create one, then press Add track. Nothing has been added yet.');
    } else messages.push('The track to add is invalid or no longer published. Nothing was added.');
  }
  if (messages.length) announce(messages.join(' '));
}

function initializePage(): void {
  readCatalogue();
  syncTrackControls();
  const nextLibrary = document.getElementById('music-library');
  if (library !== nextLibrary) {
    library = nextLibrary;
    if (library) {
      readPageLink();
      renderLibrary();
      if (shared || pendingTrackId) requestAnimationFrame(() => {
        if (library === nextLibrary) document.dispatchEvent(new CustomEvent('gwenlium:window-command', { detail: { id: 'music-library', action: 'restore' } }));
      });
    }
  }
  updateStorageStatus();
  if (!storageAvailable && !library?.querySelector('[data-library-status]')?.textContent) announce('Your personal music library is available for this visit.');
  else if (storageNotice && !library) announce(storageNotice);
}

// Astro executes this side-effect module once; delegated listeners cover replaced page content.
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>('button');
  if (!button || button.disabled) return;
  if (button.matches('[data-track-reaction]')) {
    const id = trackIdFor(button);
    const reaction = button.dataset.trackReaction;
    if (!catalogue.has(id) || (reaction !== 'like' && reaction !== 'dislike')) return;
    const previous = state.reactions[id];
    if (!previous && Object.keys(state.reactions).length >= MAX_REACTIONS) {
      announce(`This device has reached ${MAX_REACTIONS} saved reactions. Toggle off a previous reaction before adding another.`);
      return;
    }
    if (previous === reaction) delete state.reactions[id];
    else state.reactions[id] = reaction;
    persist();
    syncTrackControls();
    announce(previous === reaction ? `Your reaction to “${catalogue.get(id)!.title}” was removed.` : `${reaction === 'like' ? 'Liked' : 'Disliked'} “${catalogue.get(id)!.title}” for your personal library.`);
    return;
  }
  if (button.matches('[data-share-track]')) {
    const track = catalogue.get(trackIdFor(button));
    if (!track) { announce('This track is no longer published.'); return; }
    const url = new URL('/music/', location.origin);
    url.searchParams.set('track', track.id);
    void shareLink(url.href, track.title);
    return;
  }
  if (button.matches('[data-add-current-track], [data-add-track]')) {
    beginAdd(trackIdFor(button));
    return;
  }
  if (!library?.contains(button)) return;
  const trackAction = button.dataset.playlistTrackAction;
  if (trackAction) {
    const playlist = selectedPlaylist();
    const ids = button.dataset.listSource === 'shared' ? shared?.ids : playlist?.ids;
    const id = button.dataset.trackId || '';
    const index = ids?.indexOf(id) ?? -1;
    if (!ids || index < 0) return;
    if (trackAction === 'play') { playPlaylist(ids, id); return; }
    if (button.dataset.listSource !== 'personal' || !playlist) return;
    const title = catalogue.get(id)?.title || 'Unavailable track';
    if (trackAction === 'remove') {
      ids.splice(index, 1);
      commit(`Removed “${title}” from “${playlist.name}”.`);
    } else {
      const target = trackAction === 'up' ? index - 1 : trackAction === 'down' ? index + 1 : -1;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      commit(`Moved “${title}” to position ${target + 1} in “${playlist.name}”.`);
    }
    const focusId = trackAction === 'remove' ? ids[Math.min(index, ids.length - 1)] : id;
    const controls = library.querySelectorAll<HTMLButtonElement>('[data-playlist-track-action]');
    const focus = [...controls].find((control) => control.dataset.listSource === 'personal' && control.dataset.trackId === focusId && control.dataset.playlistTrackAction === trackAction && !control.disabled)
      || [...controls].find((control) => control.dataset.listSource === 'personal' && control.dataset.trackId === focusId && !control.disabled);
    (focus || library.querySelector<HTMLSelectElement>('[data-playlist-select]'))?.focus();
    return;
  }
  const action = button.dataset.libraryAction;
  const playlist = selectedPlaylist();
  if (action === 'cancel-add') {
    pendingTrackId = null;
    pendingTargetId = '';
    renderLibrary();
    library.querySelector<HTMLInputElement>('#playlist-create-name')?.focus();
    announce('Add cancelled. Nothing was added.');
  } else if (action === 'play-playlist' && playlist) {
    playPlaylist(playlist.ids);
  } else if (action === 'share-playlist' && playlist) {
    const ids = playlist.ids.filter((id) => catalogue.has(id));
    const url = shareUrl(playlist.name, ids);
    if (!url) { announce(`This playlist link is too long to share (limit ${MAX_LINK_LENGTH.toLocaleString('en-US')} characters). Make a smaller playlist and try again.`); return; }
    const missing = playlist.ids.length - ids.length;
    void shareLink(url, playlist.name, missing ? `${missing} removed or unknown ${missing === 1 ? 'track was' : 'tracks were'} excluded from the link.` : '');
  } else if (action === 'delete-playlist' && playlist) {
    deleteId = playlist.id;
    renderLibrary();
    library.querySelector<HTMLButtonElement>('[data-library-action="cancel-delete"]')?.focus();
  } else if (action === 'cancel-delete') {
    deleteId = null;
    renderLibrary();
    library.querySelector<HTMLButtonElement>('[data-library-action="delete-playlist"]')?.focus();
  } else if (action === 'confirm-delete' && playlist && deleteId === playlist.id) {
    state.playlists = state.playlists.filter((entry) => entry.id !== playlist.id);
    state.selectedId = state.playlists[0]?.id ?? null;
    if (shared?.savedId === playlist.id) shared.savedId = null;
    deleteId = null;
    commit(`Removed “${playlist.name}” from your personal library.`);
    (state.playlists.length ? library.querySelector<HTMLSelectElement>('[data-playlist-select]') : library.querySelector<HTMLInputElement>('#playlist-create-name'))?.focus();
  } else if (action === 'play-shared' && shared) {
    playPlaylist(shared.ids);
  } else if (action === 'save-shared' && shared && !shared.savedId) {
    const copy = createPlaylist(shared.name, shared.ids);
    if (!copy) return;
    shared.savedId = copy.id;
    commit(`Added a separate copy of “${copy.name}” with ${copy.ids.length} known tracks. Your other playlists were not changed.`);
  } else if (action === 'dismiss-shared') {
    shared = null;
    renderLibrary();
    library.querySelector<HTMLInputElement>('#playlist-create-name')?.focus();
    announce('Shared preview dismissed. Personal playlists were not changed.');
  }
}, listenerOptions);

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !library?.contains(form)) return;
  if (form.matches('[data-create-playlist], [data-rename-playlist]')) {
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>('[name="name"]')!;
    const name = cleanName(input.value);
    if (!name) {
      input.setCustomValidity(`Enter a name of 1–${MAX_NAME} characters without control characters.`);
      input.reportValidity();
      return;
    }
    if (form.matches('[data-create-playlist]')) {
      const playlist = createPlaylist(name);
      if (!playlist) return;
      input.value = '';
      if (pendingTrackId) pendingTargetId = playlist.id;
      commit(`Created “${name}”.${pendingTrackId ? ' It is selected as the destination; press Add track above to confirm.' : ''}`);
      (pendingTrackId ? library.querySelector<HTMLButtonElement>('[data-confirm-add]') : library.querySelector<HTMLSelectElement>('[data-playlist-select]'))?.focus();
    } else {
      const playlist = selectedPlaylist();
      if (!playlist) return;
      playlist.name = name;
      commit(`Playlist renamed to “${name}”.`);
    }
  } else if (form.matches('[data-add-track-form]')) {
    event.preventDefault();
    const playlist = state.playlists.find((entry) => entry.id === pendingTargetId);
    const track = pendingTrackId ? catalogue.get(pendingTrackId) : undefined;
    if (!playlist || !track) { announce('Choose a destination playlist and a published track first. Nothing was added.'); return; }
    if (playlist.ids.includes(track.id)) { announce(`“${track.title}” is already in “${playlist.name}”. Playlists keep each track once.`); return; }
    if (playlist.ids.length >= MAX_TRACKS) { announce(`“${playlist.name}” already has ${MAX_TRACKS} tracks. Choose another playlist or remove a track first.`); return; }
    playlist.ids.push(track.id);
    state.selectedId = playlist.id;
    pendingTrackId = null;
    pendingTargetId = '';
    deleteId = null;
    commit(`Added “${track.title}” to “${playlist.name}”.`);
    library.querySelector<HTMLSelectElement>('[data-playlist-select]')?.focus();
  }
}, listenerOptions);

document.addEventListener('input', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.matches('[data-library-name]')) event.target.setCustomValidity('');
}, listenerOptions);

document.addEventListener('change', (event) => {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement) || !library?.contains(select)) return;
  if (select.matches('[data-playlist-select]')) {
    if (!state.playlists.some((playlist) => playlist.id === select.value)) return;
    state.selectedId = select.value;
    deleteId = null;
    persist();
    renderLibrary();
  } else if (select.matches('[data-add-target]')) {
    pendingTargetId = select.value;
    renderLibrary();
  }
}, listenerOptions);

document.addEventListener('gwenlium:track-change', syncTrackControls, listenerOptions);
document.addEventListener('astro:page-load', initializePage, listenerOptions);
document.addEventListener('astro:before-swap', () => {
  pageVersion++;
  shareDialog?.close();
  shareDialog?.remove();
  shareDialog = null;
}, listenerOptions);

initializePage();

if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  shareDialog?.close();
  shareDialog?.remove();
});
