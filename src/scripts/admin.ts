import CMS from 'decap-cms-app';
import './admin-analytics';
import { PreparedGitHubBackend } from './admin-github';
import { previewMediaLibrary } from './admin-library';

CMS.registerBackend('gwenlium-github', PreparedGitHubBackend);
CMS.registerMediaLibrary(previewMediaLibrary);
// Keep bookmarks to the previous settings collection working.
if (location.hash.startsWith('#/collections/site/')) {
  location.replace(location.href.replace('#/collections/site/', '#/collections/pages/'));
}
CMS.init();
