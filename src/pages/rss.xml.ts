import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { load } from 'cheerio';
import { getPosts, postUrl, type Post } from '../lib/content';
import { site } from '../lib/settings';

const htmlEscapes: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]!);
}

function articleContent(post: Post, base: URL): string {
  if (post.rendered?.html === undefined) throw new Error(`Missing rendered RSS content for ${post.id}`);
  const { cover, coverAlt, excerpt, media, photos } = post.data;
  const parts = [
    cover ? `<p><img src="${escapeHtml(cover)}" alt="${escapeHtml(coverAlt)}" /></p>` : '',
    excerpt ? `<p>${escapeHtml(excerpt)}</p>` : '',
    post.rendered.html,
    ...photos.map(src => `<figure><img src="${escapeHtml(src)}" alt="" /></figure>`),
    ...media.map((item) => {
      const src = escapeHtml(item.src);
      const caption = item.caption ? `<figcaption>${escapeHtml(item.caption)}</figcaption>` : '';
      const content = item.type === 'image'
        ? `<img src="${src}" alt="${escapeHtml(item.alt)}" />`
        : `<${item.type} controls src="${src}"${item.type === 'video' && item.poster ? ` poster="${escapeHtml(item.poster)}"` : ''}></${item.type}><p><a href="${src}">${escapeHtml(item.alt || `Open ${item.type}`)}</a></p>`;
      return `<figure>${content}${caption}</figure>`;
    }),
  ];
  const $ = load(parts.join('\n'), {}, false);
  const articleUrl = new URL(postUrl(post), base);
  // Feed readers have no page URL against which to resolve links or media.
  for (const attribute of ['href', 'src', 'poster']) {
    $(`[${attribute}]`).each((_, element) => {
      const node = $(element);
      const value = node.attr(attribute);
      if (value) node.attr(attribute, new URL(value, articleUrl).href);
    });
  }
  // Keep the original image rather than site-only responsive variants in readers.
  $('picture > source').remove();
  $('[srcset]').removeAttr('srcset').removeAttr('sizes');
  return $.html();
}

export async function GET(context: APIContext): Promise<Response> {
  const base = context.site ?? new URL('https://gwenlium.dev');
  const posts = await getPosts();
  return rss({
    title: `${site.name} Journal`,
    description: site.description || `${site.name} Journal`,
    site: base,
    trailingSlash: true,
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    customData: `<language>en</language><atom:link href="${new URL('/rss.xml', base).href}" rel="self" type="application/rss+xml" />`,
    items: posts.map((post) => {
      const { title, date, excerpt, tags } = post.data;
      return {
        title,
        link: new URL(postUrl(post), base).href,
        pubDate: date,
        description: excerpt,
        categories: [post.data.section === 'life' ? 'Life' : 'Devlog', ...tags],
        content: articleContent(post, base),
      };
    }),
  });
}
