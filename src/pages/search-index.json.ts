import { getPosts, postSearchText, postUrl } from '../lib/content';
import { gallery, site, tracks } from '../lib/settings';

export const prerender = true;

export async function GET(): Promise<Response> {
  const posts = await getPosts();
  const pages = [
    { title: 'Home', url: '/', text: [site.name, site.description, site.intro, site.status].join(' ') },
    { title: 'Devlog', url: '/devlog/', text: 'Journal' },
    { title: 'Game', url: '/game/', text: [site.game.title, site.game.description, site.game.status, site.game.coverAlt].join(' ') },
    { title: 'Gallery', url: '/gallery/', text: ['Images', 'Videos', ...gallery.flatMap((item) => [item.title, item.alt, item.caption])].join(' ') },
    { title: 'Music', url: '/music/', text: ['Tracks', ...tracks.flatMap((track) => [track.title, track.coverAlt])].join(' ') },
    { title: 'About', url: '/about/', text: [site.name, site.about.body, site.about.avatarAlt].join(' ') },
    { title: 'Updates', url: '/subscribe/', text: 'Subscriptions RSS Email updates' },
  ];
  const entries = [
    ...pages.map((page) => ({ ...page, kind: 'page', text: [page.title, page.text].join(' ').replace(/\s+/g, ' ') })),
    ...posts.map((post) => ({ title: post.data.title, url: postUrl(post), kind: 'post', text: postSearchText(post) })),
  ];

  return new Response(JSON.stringify({ entries }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
