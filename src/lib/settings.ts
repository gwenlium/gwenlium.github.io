import siteData from '../content/site.json';
import aboutData from '../content/pages/about.json';
import galleryData from '../content/gallery.json';
import musicData from '../content/music.json';

export interface Link {
  label: string;
  url: string;
}

export interface GameSettings {
  title: string;
  description: string;
  status: string;
  cover: string;
  coverAlt: string;
  trailerUrl: string;
  links: Link[];
}

export interface AboutSettings {
  body: string;
  avatar: string;
  avatarAlt: string;
  links: Link[];
}

export interface SiteSettings {
  name: string;
  description: string;
  intro: string;
  status: string;
  githubUrl: string;
  featuredPost: string;
  newsletterUrl: string;
  newsletterFormAction: string;
  newsletterHeading: string;
  newsletterButtonLabel: string;
  game: GameSettings;
  about: AboutSettings;
}

export interface GalleryItem {
  id: string;
  title: string;
  src: string;
  alt: string;
  caption: string;
  type: 'image' | 'video';
  poster: string;
}

export interface MusicTrack {
  id: string;
  title: string;
  src: string;
  cover: string;
  coverAlt: string;
}

type SavedSettings = Partial<Omit<SiteSettings, 'game' | 'about'>> & { game?: Partial<GameSettings>; about?: Partial<AboutSettings> };
const settings: SavedSettings = siteData;
const savedAbout: Partial<AboutSettings> = aboutData;

export const site: SiteSettings = {
  name: settings.name ?? 'Gwenlium',
  description: settings.description ?? '',
  intro: settings.intro ?? '',
  status: settings.status ?? '',
  githubUrl: settings.githubUrl ?? 'https://github.com/gwenlium',
  featuredPost: settings.featuredPost ?? '',
  newsletterUrl: settings.newsletterUrl ?? '',
  newsletterFormAction: settings.newsletterFormAction ?? '',
  newsletterHeading: settings.newsletterHeading ?? '',
  newsletterButtonLabel: settings.newsletterButtonLabel ?? 'Subscribe',
  game: {
    title: '',
    description: '',
    status: '',
    cover: '',
    coverAlt: '',
    trailerUrl: '',
    links: [],
    ...settings.game,
  },
  about: {
    body: savedAbout.body ?? '',
    avatar: savedAbout.avatar ?? '',
    avatarAlt: savedAbout.avatarAlt ?? '',
    links: savedAbout.links ?? [],
  },
};

export const gallery: GalleryItem[] = (galleryData.items as GalleryItem[]).map((item) => ({
  id: item.id,
  title: item.title ?? '',
  src: item.src ?? '',
  alt: item.alt ?? '',
  caption: item.caption ?? '',
  type: item.type ?? 'image',
  poster: item.poster ?? '',
}));

export const tracks: MusicTrack[] = (musicData.tracks as MusicTrack[]).map((track) => ({
  id: track.id,
  title: track.title ?? '',
  src: track.src ?? '',
  cover: track.cover ?? '',
  coverAlt: track.coverAlt ?? '',
}));
