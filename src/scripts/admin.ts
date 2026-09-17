import CMS from 'decap-cms-app';
import { PreparedGitHubBackend } from './admin-github';
import { previewMediaLibrary } from './admin-library';

CMS.registerBackend('gwenlium-github', PreparedGitHubBackend);
CMS.registerMediaLibrary(previewMediaLibrary);
CMS.init();
