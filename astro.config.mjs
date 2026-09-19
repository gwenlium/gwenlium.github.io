import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import rehypeMedia from './src/plugins/rehype-media.mjs';

export default defineConfig({
  site: 'https://gwenlium.dev',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap({ filter: (page) => !page.endsWith('/game/') && !page.endsWith('/404/') && !page.endsWith('/admin/') })],
  markdown: { processor: unified({ rehypePlugins: [rehypeMedia] }) },
  vite: { server: { fs: { strict: true } } },
});
