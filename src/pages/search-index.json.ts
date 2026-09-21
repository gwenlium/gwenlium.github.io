import { pages as pageSettings } from '../lib/pages';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { load } from 'cheerio';
import { getPosts, postSearchText, postUrl, type Post } from '../lib/content';
import { gallery, site, tracks, type GalleryItem, type MusicTrack } from '../lib/settings';
import type { SearchEntry } from '../lib/search-types';
import { builtinWindowPages, systemWindowIds } from '../lib/window-catalogue.mjs';
import { getWindowDefinition, hasWindowOverride, windowDefinitions, type WindowDefinition, type WindowPage } from '../lib/windows';

export const prerender = true;

const pageRoutes: Record<Exclude<WindowPage, 'post'>, string> = {
  home: '/', devlog: '/devlog/', life: '/life/', gallery: '/gallery/', music: '/music/',
  about: '/about/', subscribe: '/subscribe/', 'not-found': '/404.html', all: '/',
};

function text(...parts: (string | undefined)[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function htmlText(html: string): string {
  const $ = load(html, {}, false);
  $('script, style, template').remove();
  $('img[alt]').each((_, element) => {
    const image = $(element);
    image.replaceWith($('<span>').text(` ${image.attr('alt') ?? ''} `));
  });
  $('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, br, div, figure, figcaption, td, th').append(' ');
  return text($.root().text());
}

function limitItems<T>(items: T[], definition: WindowDefinition): T[] {
  return definition.limit > 0 ? items.slice(0, definition.limit) : items;
}

// Keep authored ordering, unknown-item handling and limits aligned with WindowContent.
function selectItems<T>(items: T[], getId: (item: T) => string, definition: WindowDefinition): T[] {
  if (!definition.items.length) return limitItems(items, definition);
  const byId = new Map(items.map((item) => [getId(item), item]));
  return limitItems(definition.items.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  }), definition);
}

function artworkText(item: GalleryItem): string {
  return text(item.title, ...(item.src ? [item.alt, item.caption] : []));
}

function trackText(track: MusicTrack): string {
  return text(track.title, track.cover ? track.coverAlt : '');
}

function postCardText(post: Post): string {
  return text(post.data.title, post.data.excerpt, ...post.data.tags, post.data.cover ? post.data.coverAlt : '');
}

function hasDefaultContent(id: string): boolean {
  const definition = getWindowDefinition(id);
  return Boolean(definition?.enabled && definition.content === 'default');
}

export async function GET(): Promise<Response> {
  const posts = await getPosts();
  const markdown = await createMarkdownProcessor({ remarkRehype: { allowDangerousHtml: false } });
  const markdownText = async (body: string) => body.trim() ? htmlText((await markdown.render(body)).code) : '';
  const postTexts = new Map<string, string>();
  for (const post of posts) {
    const body = post.rendered?.html
      ? postSearchText(post)
      : text(post.data.title, post.data.excerpt, ...post.data.tags, await markdownText(post.body ?? ''));
    postTexts.set(post.data.permalink, text(body, post.data.cover ? post.data.coverAlt : '',
      ...post.data.media.filter((media) => media.src).flatMap((media) => [media.alt, media.caption])));
  }

  const featuredPost = posts.find((post) => post.data.permalink === site.featuredPost)
    ?? posts.find((post) => post.data.featured) ?? posts[0];
  const recentPosts = posts.filter((post) => post.id !== featuredPost?.id).slice(0, 3);
  const galleryPreview = gallery.filter((item) => item.src).slice(0, 3);
  const musicPreview = tracks.filter((track) => track.src).slice(0, 3);
  const game = site.game;
  const gameLinks = game.links.filter((link) => link.label && /^(https?:\/\/|mailto:|\/(?!\/))/.test(link.url));
  const hasHomeGame = Boolean(game.title || game.description || game.cover || game.trailerUrl || game.status || game.links.length);
  const hasGameContent = Boolean(game.title || game.description || game.status || game.cover || game.trailerUrl || gameLinks.length);
  let hasTrailer = false;
  if (game.trailerUrl) {
    try {
      const trailer = new URL(game.trailerUrl, 'https://gwenlium.dev');
      hasTrailer = trailer.protocol === 'https:' || trailer.protocol === 'http:';
    } catch { /* The game page does not render an invalid trailer address. */ }
  }

  const tagCounts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of new Set(post.data.tags)) tagCounts.set(`${post.data.section}:${tag}`, (tagCounts.get(`${post.data.section}:${tag}`) ?? 0) + 1);
  }
  const relatedPost = posts.find((post) => post.data.tags.some((tag) => (tagCounts.get(`${post.data.section}:${tag}`) ?? 0) > 1));
  const relatedPosts = relatedPost ? posts
    .filter((post) => post.id !== relatedPost.id && post.data.section === relatedPost.data.section)
    .map((post) => ({ post, sharedTags: post.data.tags.filter((tag) => relatedPost.data.tags.includes(tag)).length }))
    .filter(({ sharedTags }) => sharedTags > 0)
    .sort((a, b) => b.sharedTags - a.sharedTags)
    .slice(0, 3).map(({ post }) => post) : [];

  function windowUrl(definition: WindowDefinition): string | undefined {
    if (!definition.enabled || systemWindowIds.includes(definition.id)) return undefined;
    const builtin = Object.hasOwn(builtinWindowPages, definition.id);
    if (builtin && definition.content === 'default') {
      switch (definition.id) {
        case 'home-game': if (!hasHomeGame) return undefined; break;
        case 'home-gallery': if (!galleryPreview.length) return undefined; break;
        case 'home-music': if (!musicPreview.length) return undefined; break;
        case 'about-portrait': if (!site.about.avatar) return undefined; break;
        case 'game-trailer': if (!hasTrailer) return undefined; break;
        case 'game-details':
          if (!hasGameContent && !hasWindowOverride('game-trailer')) return undefined;
          if ((hasGameContent || hasWindowOverride('game-trailer')) && !game.description && !gameLinks.length) return undefined;
          break;
        case 'post-related': if (!relatedPost) return undefined; break;
      }
    }
    const page = builtin
      ? builtinWindowPages[definition.id as keyof typeof builtinWindowPages] as WindowPage
      : definition.page;
    const destinationPost = definition.id === 'post-related' && definition.content === 'default' ? relatedPost : posts[0];
    const route = page === 'post' ? destinationPost && postUrl(destinationPost) : pageRoutes[page];
    return route ? `${route}#${encodeURIComponent(definition.id)}` : undefined;
  }

  const subscribeText = site.newsletterFormAction ? text(site.newsletterHeading, site.newsletterButtonLabel) : '';
  function defaultWindowText(id: string): string {
    switch (id) {
      case 'home-intro': return text(site.name, site.intro);
      case 'home-game': return text(game.title, game.description, game.status,
        game.cover || /\.(mp4|webm|ogv)(?:[?#].*)?$/i.test(game.trailerUrl) ? game.coverAlt : '');
      case 'home-devlog': return text(featuredPost && postCardText(featuredPost), ...recentPosts.map((post) => post.data.title));
      case 'home-gallery': return text(...galleryPreview.map((item) => text(item.title, item.alt)));
      case 'home-music': return text(...musicPreview.map(trackText));
      case 'devlog-entries': return text(...posts.filter((post) => post.data.section === 'devlog').map(postCardText));
      case 'life-entries': return text(...posts.filter((post) => post.data.section === 'life').map(postCardText));
      case 'post-entry': return posts[0] ? postTexts.get(posts[0].data.permalink) ?? '' : '';
      case 'post-related': return text(...relatedPosts.map((post) => post.data.title));
      case 'game-details': return text(game.description, ...gameLinks.map((link) => link.label));
      case 'game-trailer': return text(game.title || 'Game', 'trailer');
      case 'gallery-content': return text(...gallery.map(artworkText));
      case 'music-catalogue': return text(...tracks.map(trackText));
      case 'about-portrait': return site.about.avatarAlt;
      case 'about-bio': return site.about.body;
      case 'subscribe-email': return subscribeText;
      default: return '';
    }
  }

  const entries = new Map<string, SearchEntry>();
  function add(entry: SearchEntry): void {
    entries.set(entry.id, { ...entry, text: text(entry.text) });
  }
  const pages = [
    { id: 'home', title: 'Home', url: '/', text: text(site.name, site.description, hasDefaultContent('home-intro') ? site.intro || site.description : '') },
    { id: 'devlog', title: pageSettings.devlog.title, url: '/devlog/', text: 'Games, code and creative projects' },
    { id: 'life', title: pageSettings.life.title, url: '/life/', text: 'Personal journal, everyday life, photos and videos' },
    { id: 'gallery', title: pageSettings.gallery.title, url: '/gallery/', text: 'Images and videos' },
    { id: 'music', title: pageSettings.music.title, url: '/music/', text: 'Music and tracks' },
    { id: 'about', title: pageSettings.about.title.replaceAll('{name}', site.name), url: '/about/', text: text(site.name, hasDefaultContent('about-bio') ? site.about.body : '', hasDefaultContent('about-portrait') && site.about.avatar ? site.about.avatarAlt : '') },
    { id: 'subscribe', title: pageSettings.subscribe.title, url: '/subscribe/', text: 'Subscriptions RSS Email updates' },
  ];
  for (const page of pages) {
    const settings = page.id === 'home' ? undefined : pageSettings[page.id as keyof typeof pageSettings];
    add({ ...page, text: text(page.text, settings?.eyebrow, settings?.intro), id: `page:${page.id}`, kind: 'page', tags: [] });
  }
  for (const post of posts) add({
    id: `post:${post.data.permalink}`, title: post.data.title, url: postUrl(post), kind: 'post',
    text: postTexts.get(post.data.permalink) ?? '', tags: post.data.tags,
  });

  const artworkDestinations = new Map<string, string>();
  const trackDestinations = new Map<string, string>();
  const windowEntries: SearchEntry[] = [];
  for (const definition of windowDefinitions) {
    const url = windowUrl(definition);
    if (!url) continue;
    let body = '';
    let tags: string[] = [];
    switch (definition.content) {
      case 'text': body = await markdownText(definition.body); break;
      case 'media':
        body = text(...limitItems(definition.media, definition).filter((media) => media.src).flatMap((media) => [media.alt, media.caption]));
        break;
      case 'links': body = text(...limitItems(definition.links, definition).map((link) => link.label)); break;
      case 'devlog':
      case 'life': {
        const selected = selectItems(posts.filter((post) => post.data.section === definition.content), (post) => post.data.permalink, definition);
        body = text(...selected.map(postCardText));
        tags = [...new Set(selected.flatMap((post) => post.data.tags))];
        break;
      }
      case 'gallery': {
        const selected = selectItems(gallery, (item) => item.id, definition);
        body = text(...selected.map(artworkText));
        for (const item of selected) if (!artworkDestinations.has(item.id)) artworkDestinations.set(item.id, url);
        break;
      }
      case 'music': {
        const selected = selectItems(tracks, (track) => track.id, definition);
        body = text(...selected.map(trackText));
        for (const track of selected) if (!trackDestinations.has(track.id)) trackDestinations.set(track.id, url);
        break;
      }
      case 'subscribe': body = subscribeText; break;
      case 'default': body = defaultWindowText(definition.id); break;
    }
    windowEntries.push({ id: `window:${definition.id}`, title: definition.title, url, kind: 'window', text: body, tags });
  }

  const galleryDefault = hasDefaultContent('gallery-content');
  for (const item of gallery) {
    const url = galleryDefault ? `/gallery/#${encodeURIComponent(`work-${item.id}`)}` : artworkDestinations.get(item.id);
    if (url) add({ id: `artwork:${item.id}`, title: item.title, url, kind: 'artwork', text: artworkText(item), tags: [] });
  }
  const musicDefault = hasDefaultContent('music-catalogue');
  for (const track of tracks) {
    const url = musicDefault ? `/music/#${encodeURIComponent(`track-${track.id}`)}` : trackDestinations.get(track.id);
    if (url) add({ id: `track:${track.id}`, title: track.title, url, kind: 'track', text: trackText(track), tags: [] });
  }
  for (const entry of windowEntries) add(entry);

  return new Response(JSON.stringify({ entries: [...entries.values()] }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
