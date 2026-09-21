import about from '../content/pages/about.json';
import devlog from '../content/pages/devlog.json';
import life from '../content/pages/life.json';
import gallery from '../content/pages/gallery.json';
import music from '../content/pages/music.json';
import subscribe from '../content/pages/subscribe.json';
import notfound from '../content/pages/not-found.json';

export interface PageMedia { type: 'image' | 'video' | 'audio'; src: string; alt?: string; caption?: string; poster?: string }
interface PageCopy { title: string; eyebrow?: string; intro?: string }
function page<T extends PageCopy>(data: T) {
  return { ...data, eyebrow: data.eyebrow ?? '', intro: data.intro ?? '' };
}
const aboutContent = about as PageCopy & { body?: string; avatar?: string; avatarAlt?: string; links?: { label: string; url: string }[]; photos?: string[]; media?: PageMedia[] };
export const pages = {
  about: { ...page(aboutContent), photos: aboutContent.photos ?? [], media: aboutContent.media ?? [] },
  devlog: page(devlog), life: page(life), gallery: page(gallery), music: page(music),
  subscribe: page(subscribe), 'not-found': page(notfound),
};
