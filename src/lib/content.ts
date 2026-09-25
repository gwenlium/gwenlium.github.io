import { getCollection, type CollectionEntry } from 'astro:content';
import { load } from 'cheerio';
import { relative, resolve, sep } from 'node:path';
import { previewText } from './preview-text.mjs';
import { mediaKindOf } from './embed.mjs';
import manifest from '../generated/media.json';
import registry from '../content/media-previews.json';

export type Post = CollectionEntry<'posts'>;

export async function getPosts(section?: 'devlog' | 'life'): Promise<Post[]> {
  const posts = await getCollection('posts');
  const permalinks = new Map<string, string>();
  const now = Date.now();

  for (const post of posts) {
    const permalink = post.data.permalink;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(permalink)) continue;
    const existing = permalinks.get(permalink);
    if (existing !== undefined) {
      throw new Error(`Duplicate post permalink "${permalink}" in "${existing}" and "${post.id}".`);
    }
    permalinks.set(permalink, post.id);
  }

  return posts
    .filter(({ data }) => (!section || data.section === section) && !data.draft && Number.isFinite(data.date.getTime()) && data.date.getTime() <= now
      && (data.publishAt === undefined || data.publishAt.getTime() <= now))
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime()
      || (a.data.permalink < b.data.permalink ? -1 : a.data.permalink > b.data.permalink ? 1 : 0));
}

export function postUrl(post: Post): string {
  return `/${post.data.section}/${post.data.permalink}/`;
}

export function postSourceFile(post: Post): string {
  if (!post.filePath) throw new Error(`Missing source filepath for post ${post.id}.`);
  const path = relative(resolve('src/content/posts'), resolve(post.filePath)).split(sep).join('/');
  if (path.startsWith('../') || !path.endsWith('.md')) throw new Error(`Invalid source filepath for post ${post.id}.`);
  return `src/content/posts/${path}`;
}

function postBodyText(post: Post): string {
  const html = post.rendered?.html;
  let body = post.body ?? '';
  if (html) {
    const $ = load(html);
    $('script, style').remove();
    $('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, br').append(' ');
    body = $.root().text();
  }
  return body;
}

export function postSearchText(post: Post): string {
  return [post.data.title, post.data.excerpt, ...post.data.tags, postBodyText(post)].join(' ').replace(/\s+/g, ' ');
}

/**
 * The picture that stands for a post in lists and link previews: its cover, otherwise the first
 * picture it has (media list, then text). `still` is a small first frame for an animation.
 */
export function postPicture(post: Post): { src: string; alt: string; derived: boolean; still?: string } | undefined {
  const found = (src: string, alt: string, derived: boolean) => {
    const record = (manifest as Record<string, { still?: boolean; sources?: { webp?: { src: string; width: number }[] } }>)[src];
    const still = record?.still ? record.sources?.webp?.at(-1)?.src : undefined;
    return { src, alt, derived, ...(still ? { still } : {}) };
  };
  // An animation (a prepared looping video) stands in with its registered still.
  const posterOf = (src: string) => (registry.files as Record<string, { loop?: boolean; poster?: string }>)[src]?.poster;
  if (post.data.cover) return found(post.data.cover, post.data.coverAlt ?? '', false);
  if (post.data.photos[0]) return found(post.data.photos[0], '', true);
  for (const item of post.data.media) {
    if (item.type === 'image' && item.src) return found(item.src, item.alt ?? '', true);
    const poster = item.type === 'video' ? posterOf(item.src) : undefined;
    if (poster) return found(poster, item.alt ?? '', true);
  }
  for (const match of (post.body ?? '').matchAll(/!\[((?:\\.|[^\]\\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const alt = match[1].replace(/\\(.)/g, '$1');
    if (mediaKindOf(match[2]) === 'image') return found(match[2], alt, true);
    const poster = mediaKindOf(match[2]) === 'video' ? posterOf(match[2]) : undefined;
    if (poster) return found(poster, alt, true);
  }
}

export function postPreview(post: Post): string {
  return previewText(post.data.excerpt.trim() || postBodyText(post));
}

const dateFormat = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDate(date: Date): string {
  return dateFormat.format(date);
}
