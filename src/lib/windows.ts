import data from '../content/windows.json';
import { builtinWindowPages } from './window-catalogue.mjs';
import type { Link } from './settings';

export type WindowPage = 'home' | 'devlog' | 'life' | 'post' | 'gallery' | 'music' | 'about' | 'subscribe' | 'not-found' | 'all';
export type WindowContent = 'default' | 'text' | 'media' | 'links' | 'devlog' | 'life' | 'gallery' | 'music' | 'subscribe';
export type WindowTone = 'sage' | 'pink' | 'lavender';
export interface WindowMedia {
  type: 'image' | 'video' | 'audio';
  src: string;
  alt: string;
  caption: string;
  poster: string;
}
export interface WindowDefinition {
  id: string;
  page: WindowPage;
  title: string;
  enabled: boolean;
  tone: WindowTone;
  floating: boolean;
  initiallyClosed: boolean;
  width: number;
  height: number;
  x?: number;
  y?: number;
  content: WindowContent;
  body: string;
  media: WindowMedia[];
  links: Link[];
  items: string[];
  limit: number;
}

export const windowDefinitions: WindowDefinition[] = data.windows as WindowDefinition[];
const definitions: Record<string, WindowDefinition> = Object.fromEntries(windowDefinitions.map((window) => [window.id, window]));

export function getWindowDefinition(id: string): WindowDefinition | undefined {
  return Object.hasOwn(definitions, id) ? definitions[id] : undefined;
}

export function hasWindowOverride(id: string): boolean {
  const definition = getWindowDefinition(id);
  return Boolean(definition?.enabled && definition.content !== 'default');
}

export function customWindowsForPage(page: WindowPage): WindowDefinition[] {
  return windowDefinitions.filter((window) => window.enabled && !Object.hasOwn(builtinWindowPages, window.id)
    && (window.page === 'all' || window.page === page));
}
