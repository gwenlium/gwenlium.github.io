import { getCollection, type CollectionEntry } from 'astro:content';
import { load } from 'cheerio';
import { relative, resolve, sep } from 'node:path';
import { previewText } from './preview-text.mjs';

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
