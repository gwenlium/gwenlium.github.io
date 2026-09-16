import { getCollection, type CollectionEntry } from 'astro:content';
import { load } from 'cheerio';

export type Post = CollectionEntry<'posts'>;

export async function getPosts(): Promise<Post[]> {
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
    .filter(({ data }) => !data.draft && Number.isFinite(data.date.getTime()) && data.date.getTime() <= now)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime()
      || (a.data.permalink < b.data.permalink ? -1 : a.data.permalink > b.data.permalink ? 1 : 0));
}

export function postUrl(post: Post): string {
  return `/devlog/${post.data.permalink}/`;
}

export function postSearchText(post: Post): string {
  const html = post.rendered?.html;
  let body = post.body ?? '';
  if (html) {
    const $ = load(html);
    $('script, style').remove();
    $('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, br').append(' ');
    body = $.root().text();
  }
  return [post.data.title, post.data.excerpt, ...post.data.tags, body].join(' ').replace(/\s+/g, ' ');
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
