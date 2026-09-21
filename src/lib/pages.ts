import about from '../content/pages/about.json';
import devlog from '../content/pages/devlog.json';
import life from '../content/pages/life.json';
import gallery from '../content/pages/gallery.json';
import music from '../content/pages/music.json';
import subscribe from '../content/pages/subscribe.json';
import notfound from '../content/pages/not-found.json';

export interface PageMedia { type: 'image' | 'video' | 'audio'; src: string; alt?: string; caption?: string; poster?: string }

export const pages = { about: { ...about, photos: about.photos as string[], media: about.media as PageMedia[] }, devlog, life, gallery, music, subscribe, 'not-found': notfound };
