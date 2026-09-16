import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getPosts, postUrl } from '../lib/content';
import { site } from '../lib/settings';

const htmlEscapes: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]!);
}

export async function GET(context: APIContext): Promise<Response> {
  const base = context.site ?? new URL('https://gwenlium.dev');
  const posts = await getPosts();
  return rss({
    title: `${site.name} · Devlog`,
    description: site.description || `${site.name} · Devlog`,
    site: base,
    trailingSlash: true,
    customData: '<language>en</language>',
    items: posts.map((post) => {
      const { title, date, excerpt, tags, cover, coverAlt } = post.data;
      const coverHtml = cover
        ? `<p><img src="${escapeHtml(new URL(cover, base).href)}" alt="${escapeHtml(coverAlt)}" /></p>`
        : '';
      return {
        title,
        link: new URL(postUrl(post), base).href,
        pubDate: date,
        description: excerpt,
        categories: tags,
        ...(coverHtml ? { content: `${coverHtml}${excerpt ? `<p>${escapeHtml(excerpt)}</p>` : ''}` } : {}),
      };
    }),
  });
}
