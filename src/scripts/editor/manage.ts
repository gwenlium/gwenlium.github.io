import type { EditorBinding } from '../../lib/editor-types';
import type { SiteEditorStore } from './store';
import { checkField, linksEditor, listEditor, mediaField, pickFiles, section, selectField, textField, topicsField, type Field, type Link } from './forms';
import { button, errorText, node, openDialog, toast } from './ui';
import { createRichText } from './rich-text';
import { chooseFromLibrary, stageFiles } from './media';
import { canCrop, cropPicture } from './crop';

/** Owner dialogs for everything that is not text on a page: settings, collections, lists. */

const siteFile = 'src/content/site.json';
const galleryFile = 'src/content/gallery.json';
const musicFile = 'src/content/music.json';
const aboutFile = 'src/content/pages/about.json';
const whole = (file: string, label: string): EditorBinding => ({ file, field: '', label, format: 'text' });
const today = () => new Date().toISOString().slice(0, 10);

type MediaItem = { type: 'image' | 'video' | 'audio'; src: string; alt: string; caption: string; poster: string };
type GalleryItem = { id: string; title: string; type: 'image' | 'video'; src: string; alt: string; caption: string; poster: string; topics: string[] };
type Track = { id: string; title: string; topics: string[]; src: string; cover: string; coverAlt: string };

function saveButton(label: string, run: () => Promise<void>, status: HTMLElement): HTMLButtonElement {
  const save = button(label, () => void (async () => {
    save.disabled = true;
    try { await run(); }
    catch (error) { status.textContent = errorText(error, 'Could not save.'); }
    finally { save.disabled = false; }
  })(), 'owner-button owner-button--primary');
  return save;
}

/** Same content, ignoring key order and fields that are empty on one side and missing on the other. */
function unchanged(before: unknown, after: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== '' && item !== false && item !== null && item !== undefined && !(Array.isArray(item) && !item.length))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
}

async function load<T>(store: SiteEditorStore, file: string): Promise<T> {
  return structuredClone(await store.get(whole(file, file))) as T;
}

/** Preview of one media item for list rows. */
function thumbnail(store: SiteEditorStore, type: string, src: string): HTMLElement {
  const box = node('div', undefined, 'writer-media__preview');
  if (type === 'image') box.append(Object.assign(node('img'), { src: store.resolveMedia(src), alt: '' }));
  else if (type === 'video') box.append(Object.assign(node('video'), { src: store.resolveMedia(src), muted: true, preload: 'metadata' }));
  else box.append(node('span', '♪ Audio', 'writer-media__audio'));
  return box;
}

function input(value: string, placeholder: string, label: string, multiline = false): Field<string> {
  const element = multiline ? node('textarea', undefined, 'owner-field') : node('input', undefined, 'owner-field');
  if (element instanceof HTMLTextAreaElement) element.rows = 2;
  element.value = value;
  element.placeholder = placeholder;
  element.setAttribute('aria-label', label);
  return { element, get: () => element.value };
}

/** A list of pictures, video and audio with descriptions and captions (About page, media windows). */
export function mediaListField(store: SiteEditorStore, label: string, items: MediaItem[], onStatus: (text: string) => void): Field<MediaItem[]> {
  return listEditor<MediaItem>({
    label, items, addLabel: '+ Add pictures, video or audio', empty: 'No media yet.',
    create: async () => (await pickFiles(store, '.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.m4v,.webm,.mp3,.wav,.flac,.ogg,.m4a,.aac', true, onStatus))
      .map(file => ({ type: file.kind, src: file.url, alt: '', caption: '', poster: '' })),
    row: item => {
      const row = node('div', undefined, 'owner-media-row');
      const fields = node('div', undefined, 'writer-media__fields');
      const alt = input(item.alt, item.type === 'image' ? 'Describe the picture' : `What is in this ${item.type}?`, 'Description');
      const caption = input(item.caption, 'Caption (optional)', 'Caption', true);
      fields.append(alt.element, caption.element);
      row.append(thumbnail(store, item.type, item.src), fields);
      return { element: row, get: () => ({ ...item, alt: alt.get().trim(), caption: caption.get() }) };
    },
  });
}

export async function openSiteSettings(store: SiteEditorStore, onSaved: () => Promise<void> | void): Promise<void> {
  const { dialog, body, footer, status } = openDialog('Site settings', { wide: true });
  const site = await load<Record<string, unknown>>(store, siteFile).catch(error => { status.textContent = errorText(error); return undefined; });
  if (!site) return;
  const text = (key: string) => typeof site[key] === 'string' ? site[key] as string : '';
  const game = (site.game && typeof site.game === 'object' ? site.game : {}) as Record<string, unknown>;
  const gameText = (key: string) => typeof game[key] === 'string' ? game[key] as string : '';
  const entries = (await store.entries().catch(() => [])).filter(entry => !entry.draft && entry.date && entry.date <= today() && entry.permalink);
  const onStatus = (value: string) => { status.textContent = value; };

  const name = textField('Display name', text('name'));
  const description = textField('Site description', text('description'), { multiline: true, hint: 'Shown in search results and link previews.' });
  const statusLine = textField('Short status', text('status'), { hint: 'The little line next to your name in the header. Leave empty to hide it.' });
  const github = textField('GitHub profile', text('githubUrl'), { type: 'url', placeholder: 'https://github.com/…' });
  const watermark = textField('Watermark on pictures', text('watermarkText'), { multiline: true, hint: 'Added to every prepared picture and video. Empty uses © and your display name.' });
  const intro = textField('Home page introduction', text('intro'), { multiline: true, hint: 'Empty shows the site description instead.' });
  const featured = selectField('Featured on the home page', text('featuredPost'), [['', 'Automatic: an entry marked “Feature”, otherwise the newest'], ...entries.map(entry => [entry.permalink, entry.title || entry.permalink] as [string, string])]);
  const newsletterHeading = textField('Newsletter heading', text('newsletterHeading'));
  const newsletterButton = textField('Newsletter button', text('newsletterButtonLabel'));
  const newsletterUrl = textField('follow.it page', text('newsletterUrl'), { type: 'url', hint: 'Where people subscribe by email.' });
  const newsletterAction = textField('follow.it form address', text('newsletterFormAction'), { type: 'url', hint: 'The form action from follow.it’s embed code (starts with https://api.follow.it/subscription-form/).' });
  const gameTitle = textField('Game title', gameText('title'));
  const gameStatus = textField('Development status', gameText('status'));
  const gameDescription = textField('Description', gameText('description'), { multiline: true });
  const gameCover = mediaField(store, 'Cover', { src: gameText('cover'), alt: gameText('coverAlt') }, { describe: true, onStatus });
  const gameTrailer = textField('Trailer', gameText('trailerUrl'), { type: 'url', hint: 'A YouTube or Vimeo address, or leave empty.' });
  const gameLinks = linksEditor('Game links', Array.isArray(game.links) ? game.links as Link[] : []);
  const maintenance = checkField('Maintenance mode', site.maintenanceEnabled === true, 'When published, visitors see only the message below. You can still sign in and switch it off.');
  const maintenanceHeading = textField('Maintenance heading', text('maintenanceHeading'));
  const maintenanceMessage = textField('Maintenance message', text('maintenanceMessage'), { multiline: true });

  body.append(
    section('General', name.element, description.element, statusLine.element, github.element, watermark.element),
    section('Home page', intro.element, featured.element),
    section('Newsletter', newsletterHeading.element, newsletterButton.element, newsletterUrl.element, newsletterAction.element),
    section('Game in the Devlog', gameTitle.element, gameStatus.element, gameDescription.element, gameCover.element, gameTrailer.element, gameLinks.element),
    section('Maintenance', maintenance.element, maintenanceHeading.element, maintenanceMessage.element),
  );
  footer.append(button('Cancel', () => dialog.close()), saveButton('Save', async () => {
    if (!name.get().trim()) throw new Error('Your display name cannot be empty.');
    const cover = gameCover.get();
    if (cover.src && !cover.alt) throw new Error('Describe the game cover.');
    const links = gameLinks.get().filter(link => link.label || link.url !== 'https://');
    if (links.some(link => !link.label || !/^https?:\/\//.test(link.url))) throw new Error('Every game link needs a label and a full web address.');
    const next = {
      ...site,
      name: name.get().trim(), description: description.get(), status: statusLine.get(), githubUrl: github.get().trim(), watermarkText: watermark.get(),
      intro: intro.get(), featuredPost: featured.get(),
      newsletterHeading: newsletterHeading.get(), newsletterButtonLabel: newsletterButton.get(), newsletterUrl: newsletterUrl.get().trim(), newsletterFormAction: newsletterAction.get().trim(),
      maintenanceEnabled: maintenance.get(), maintenanceHeading: maintenanceHeading.get(), maintenanceMessage: maintenanceMessage.get(),
      game: { ...game, title: gameTitle.get(), status: gameStatus.get(), description: gameDescription.get(), cover: cover.src, coverAlt: cover.alt, trailerUrl: gameTrailer.get().trim(), links },
    };
    if (unchanged(site, next)) { dialog.close(); toast('Nothing changed.'); return; }
    await store.set(whole(siteFile, 'Site settings'), next);
    await onSaved();
    dialog.close();
    toast(maintenance.get() && site.maintenanceEnabled !== true ? 'Saved. Maintenance mode turns on for visitors when you publish.' : 'Site settings saved. Publish when ready.');
  }, status));
}

async function knownTopics(store: SiteEditorStore): Promise<string[]> {
  const [gallery, music] = await Promise.all([
    load<{ items?: GalleryItem[] }>(store, galleryFile).catch(() => ({ items: [] })),
    load<{ tracks?: Track[] }>(store, musicFile).catch(() => ({ tracks: [] })),
  ]);
  return [...new Set([...(gallery.items ?? []), ...(music.tracks ?? [])].flatMap(item => item.topics ?? []))].sort((a, b) => a.localeCompare(b));
}

export async function openGallery(store: SiteEditorStore, onSaved: () => Promise<void> | void): Promise<void> {
  const { dialog, body, footer, status } = openDialog('Gallery', { wide: true });
  const data = await load<{ items: GalleryItem[] }>(store, galleryFile).catch(error => { status.textContent = errorText(error); return undefined; });
  if (!data) return;
  const topics = await knownTopics(store);
  const onStatus = (value: string) => { status.textContent = value; };
  body.append(node('p', 'Everything shown on the Gallery page, in this order. Titles and descriptions also appear there; topics become its filters.', 'owner-hint'));
  const list = listEditor<GalleryItem>({
    label: 'Pictures and videos', items: data.items ?? [], addLabel: '+ Add pictures or video', empty: 'The gallery is empty.',
    create: async () => (await pickFiles(store, '.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.m4v,.webm', true, onStatus))
      .filter(file => file.kind !== 'audio')
      .map(file => ({ id: `picture-${crypto.randomUUID()}`, title: file.name.replace(/[-_]+/g, ' ').trim(), type: file.kind as 'image' | 'video', src: file.url, alt: '', caption: '', poster: '', topics: [] })),
    row: item => {
      const row = node('div', undefined, 'owner-media-row');
      const fields = node('div', undefined, 'writer-media__fields');
      const title = input(item.title, 'Title (required)', 'Title');
      const alt = input(item.alt, 'Describe it for people who cannot see it', 'Description');
      const caption = input(item.caption, 'Caption (optional)', 'Caption', true);
      const itemTopics = topicsField('Topics', item.topics ?? [], topics);
      const poster = item.type === 'video' ? mediaField(store, 'Poster picture (optional)', { src: item.poster }, { onStatus }) : undefined;
      fields.append(title.element, alt.element, caption.element, itemTopics.element, ...(poster ? [poster.element] : []));
      row.append(thumbnail(store, item.type, item.src), fields);
      return { element: row, get: () => ({ ...item, title: title.get().trim(), alt: alt.get().trim(), caption: caption.get(), topics: itemTopics.get(), poster: poster ? poster.get().src : item.poster }) };
    },
  });
  body.append(list.element);
  footer.append(button('Cancel', () => dialog.close()), saveButton('Save', async () => {
    const items = list.get().map(item => ({ ...item, title: item.title.trim() }));
    if (items.some(item => !item.title)) throw new Error('Every gallery item needs a title.');
    if (unchanged(data.items ?? [], items)) { dialog.close(); toast('Nothing changed.'); return; }
    await store.set({ ...whole(galleryFile, 'Gallery'), field: '/items' }, items);
    await onSaved();
    dialog.close();
    toast('Gallery saved. Publish when ready.');
  }, status));
}

export async function openMusic(store: SiteEditorStore, onSaved: () => Promise<void> | void): Promise<void> {
  const { dialog, body, footer, status } = openDialog('Music', { wide: true });
  const data = await load<{ tracks: Track[] }>(store, musicFile).catch(error => { status.textContent = errorText(error); return undefined; });
  if (!data) return;
  const topics = await knownTopics(store);
  const onStatus = (value: string) => { status.textContent = value; };
  body.append(node('p', 'Tracks in the music player and on the Music page, in this order. Audio is converted to MP3 on this device.', 'owner-hint'));
  const list = listEditor<Track>({
    label: 'Tracks', items: data.tracks ?? [], addLabel: '+ Add tracks', empty: 'No tracks yet.',
    create: async () => (await pickFiles(store, '.mp3,.wav,.flac,.ogg,.oga,.opus,.m4a,.aac,.aif,.aiff', true, onStatus))
      .filter(file => file.kind === 'audio')
      .map(file => ({ id: `track-${crypto.randomUUID()}`, title: file.name.replace(/[-_]+/g, ' ').trim(), topics: [], src: file.url, cover: '', coverAlt: '' })),
    row: track => {
      const row = node('div', undefined, 'owner-media-row');
      const fields = node('div', undefined, 'writer-media__fields');
      const title = input(track.title, 'Title (required)', 'Track title');
      const audio = Object.assign(node('audio'), { src: store.resolveMedia(track.src), controls: true, preload: 'none' });
      const trackTopics = topicsField('Topics', track.topics ?? [], topics);
      const cover = mediaField(store, 'Cover', { src: track.cover, alt: track.coverAlt }, { describe: true, onStatus });
      fields.append(title.element, audio, trackTopics.element, cover.element);
      row.append(thumbnail(store, 'audio', track.src), fields);
      return { element: row, get: () => { const picked = cover.get(); return { ...track, title: title.get().trim(), topics: trackTopics.get(), cover: picked.src, coverAlt: picked.alt }; } };
    },
  });
  body.append(list.element);
  footer.append(button('Cancel', () => dialog.close()), saveButton('Save', async () => {
    const tracks = list.get().map(track => ({ ...track, title: track.title.trim() }));
    if (tracks.some(track => !track.title)) throw new Error('Every track needs a title.');
    if (tracks.some(track => track.cover && !track.coverAlt.trim())) throw new Error('Describe every track cover.');
    if (unchanged(data.tracks ?? [], tracks)) { dialog.close(); toast('Nothing changed.'); return; }
    await store.set({ ...whole(musicFile, 'Music'), field: '/tracks' }, tracks);
    await onSaved();
    dialog.close();
    toast('Music saved. Publish when ready.');
  }, status));
}

export async function openAboutDetails(store: SiteEditorStore, onSaved: () => Promise<void> | void): Promise<void> {
  const { dialog, body, footer, status } = openDialog('About page', { wide: true });
  const about = await load<Record<string, unknown>>(store, aboutFile).catch(error => { status.textContent = errorText(error); return undefined; });
  if (!about) return;
  const onStatus = (value: string) => { status.textContent = value; };
  const text = (key: string) => (typeof about[key] === 'string' ? about[key] as string : '');
  const eyebrow = textField('Small heading', text('eyebrow'), { hint: 'Shown above the title.' });
  const title = textField('Title', text('title'), { hint: '{name} is replaced by the site name.' });
  const intro = textField('Introduction', text('intro'), { multiline: true, hint: 'Optional, shown under the title.' });
  const bioField = node('div', undefined, 'writer-field');
  bioField.append(node('span', 'Your bio', 'writer-field__label'));
  const bioHost = node('div');
  bioField.append(bioHost);
  const bio = createRichText(bioHost, {
    markdown: text('body'), placeholder: 'Write about yourself…', label: 'Your bio', compact: true,
    resolveMedia: url => store.resolveMedia(url),
    addPictures: async files => (await stageFiles(store, files, onStatus)).map(file => file.url),
    chooseFromLibrary: () => chooseFromLibrary(store, true),
    mediaInfo: url => store.mediaInfo(url),
    crop: { available: canCrop, open: src => cropPicture(store, src, onStatus) },
    onChange: () => undefined, onStatus,
  });
  dialog.addEventListener('close', () => bio.destroy(), { once: true });
  const portrait = mediaField(store, 'Portrait', { src: typeof about.avatar === 'string' ? about.avatar : '', alt: typeof about.avatarAlt === 'string' ? about.avatarAlt : '' }, { describe: true, onStatus });
  const links = linksEditor('Profile links', Array.isArray(about.links) ? about.links as Link[] : []);
  const photos = Array.isArray(about.photos) ? (about.photos as string[]).map(src => ({ type: 'image' as const, src, alt: '', caption: '', poster: '' })) : [];
  const media = mediaListField(store, 'Pictures, video and audio', [...photos, ...(Array.isArray(about.media) ? about.media as MediaItem[] : [])], onStatus);
  body.append(eyebrow.element, title.element, intro.element, bioField, portrait.element, links.element, media.element);
  footer.append(button('Cancel', () => dialog.close()), saveButton('Save', async () => {
    const picture = portrait.get();
    if (!title.get().trim()) throw new Error('Give the page a title.');
    if (bio.missingDescriptions()) { bio.focusMissingDescription(); throw new Error('Describe every picture in your bio.'); }
    if (picture.src && !picture.alt) throw new Error('Describe the portrait.');
    const list = links.get().filter(link => link.label || link.url !== 'https://');
    if (list.some(link => !link.label || !/^https?:\/\//.test(link.url))) throw new Error('Every link needs a label and a full web address.');
    const next: Record<string, unknown> = {
      ...about, eyebrow: eyebrow.get().trim(), title: title.get().trim(), intro: intro.get().trim(), body: bio.getMarkdown(),
      avatar: picture.src, avatarAlt: picture.alt, links: list, media: media.get(),
    };
    delete next.photos;
    if (unchanged({ ...about, media: [...photos, ...(Array.isArray(about.media) ? about.media as MediaItem[] : [])], photos: undefined }, next)) { dialog.close(); toast('Nothing changed.'); return; }
    await store.set(whole(aboutFile, 'About page'), next);
    await onSaved();
    dialog.close();
    toast('About page saved. Publish when ready.');
  }, status));
}

type WindowContent = { content: string; media: MediaItem[]; links: Link[]; items: string[]; limit: number };

/** What a custom window shows: text, pictures, links, or a chosen set of entries, pictures or tracks. */
export async function windowContentField(store: SiteEditorStore, current: WindowContent, onStatus: (text: string) => void): Promise<Field<WindowContent>> {
  const wrap = node('div', undefined, 'owner-window-content');
  const [entries, gallery, music] = await Promise.all([
    store.entries().catch(() => []),
    load<{ items?: GalleryItem[] }>(store, galleryFile).catch(() => ({ items: [] as GalleryItem[] })),
    load<{ tracks?: Track[] }>(store, musicFile).catch(() => ({ tracks: [] as Track[] })),
  ]);
  const published = (section: string) => entries.filter(entry => entry.section === section && !entry.draft && entry.date && entry.date <= today() && entry.permalink);
  const kinds: [string, string][] = [['text', 'Text and pictures'], ['media', 'A picture or video slideshow'], ['links', 'A list of links'], ['devlog', 'Devlog entries'], ['life', 'Life entries'], ['gallery', 'Gallery pictures'], ['music', 'Music tracks'], ['subscribe', 'The subscribe box']];
  const kind = selectField('Shows', current.content === 'default' ? 'text' : current.content, kinds);
  const panel = node('div', undefined, 'owner-window-content__panel');
  let part: () => Partial<WindowContent> = () => ({});
  const choices = (label: string, options: [string, string][]): Field<string[]> => {
    const box = node('div', undefined, 'writer-field');
    box.append(node('span', label, 'writer-field__label'), node('p', 'Pick some to show only those, in this order, or none to show the newest.', 'owner-hint'));
    const inputs = options.map(([value, text]) => {
      const choice = checkField(text, current.items.includes(value));
      box.append(choice.element);
      return { value, choice };
    });
    if (!options.length) box.append(node('p', 'Nothing to choose from yet.', 'owner-hint'));
    return { element: box, get: () => inputs.filter(({ choice }) => choice.get()).map(({ value }) => value) };
  };
  const limitField = () => textField('How many at most', String(current.limit || ''), { type: 'number', hint: 'Empty shows all of them.' });
  const render = () => {
    panel.replaceChildren();
    const value = kind.get();
    if (value === 'text') { panel.append(node('p', 'Write the text right in the window with Edit this page.', 'owner-hint')); part = () => ({}); }
    else if (value === 'media') { const media = mediaListField(store, 'Pictures and videos', current.media, onStatus); panel.append(media.element); part = () => ({ media: media.get() }); }
    else if (value === 'links') { const links = linksEditor('Links', current.links); panel.append(links.element); part = () => ({ links: links.get().filter(link => link.label && link.url) }); }
    else if (value === 'subscribe') { panel.append(node('p', 'Shows the RSS and email subscription options from Site settings.', 'owner-hint')); part = () => ({}); }
    else {
      const options: [string, string][] = value === 'gallery' ? (gallery.items ?? []).map(item => [item.id, item.title])
        : value === 'music' ? (music.tracks ?? []).map(track => [track.id, track.title])
        : published(value).map(entry => [entry.permalink, entry.title || entry.permalink]);
      const picked = choices(value === 'gallery' ? 'Pictures' : value === 'music' ? 'Tracks' : 'Entries', options);
      const limit = limitField();
      panel.append(picked.element, limit.element);
      part = () => ({ items: picked.get(), limit: Math.max(0, Math.floor(Number(limit.get()) || 0)) });
    }
  };
  kind.element.addEventListener('change', render);
  render();
  wrap.append(kind.element, panel);
  return {
    element: wrap,
    get: () => {
      const value = kind.get();
      // Fields that do not belong to the chosen kind are cleared so nothing hidden stays selected.
      return { content: value, media: [], links: [], items: [], limit: 0, ...part() } as WindowContent;
    },
  };
}
