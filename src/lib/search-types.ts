export type SearchKind = 'page' | 'post' | 'window' | 'artwork' | 'track';

export interface SearchEntry {
  id: string;
  title: string;
  url: string;
  kind: SearchKind;
  text: string;
  tags: string[];
}

export interface SearchHit extends SearchEntry {
  score: number;
  terms: string[];
  snippet: string;
}

export interface SearchIndex {
  search(query: string, kind?: SearchKind | 'all'): SearchHit[];
}

export const searchKindLabels: Record<SearchKind, string> = {
  page: 'Page',
  post: 'Post',
  window: 'Window',
  artwork: 'Artwork',
  track: 'Track',
};
