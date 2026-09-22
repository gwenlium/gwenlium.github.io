import CMS from 'decap-cms-app';
import './admin-analytics';
import { PreparedGitHubBackend } from './admin-github';
import { previewMediaLibrary } from './admin-library';

CMS.registerBackend('gwenlium-github', PreparedGitHubBackend);
CMS.registerMediaLibrary(previewMediaLibrary);
CMS.registerEventListener({
  name: 'preSave',
  handler: ({ entry }) => {
    if (!['devlog', 'life'].includes(entry.get('collection'))) return;
    const data = entry.get('data');
    if (data.get('draft') !== false) return;
    const cover = data.get('cover');
    const alt = data.get('coverAlt');
    if (typeof cover === 'string' && cover.trim() && (typeof alt !== 'string' || !alt.trim())) {
      throw new Error('Cover alternative text is required when a cover image is selected. Describe the image, remove the cover, or turn Draft on before saving.');
    }
  },
});
// Keep bookmarks to the previous settings collection working.
if (location.hash.startsWith('#/collections/site/')) {
  location.replace(location.href.replace('#/collections/site/', '#/collections/pages/'));
}
CMS.init();
