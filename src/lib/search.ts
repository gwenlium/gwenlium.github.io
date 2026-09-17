import MiniSearch, { type Query } from 'minisearch';
import type { SearchEntry, SearchHit, SearchIndex } from './search-types';

const MAX_QUERY_LENGTH = 2048;
const MAX_QUERY_TERMS = 128;
const SNIPPET_LENGTH = 180;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

interface PreparedEntry {
  id: number;
  source: SearchEntry;
  title: string;
  text: string;
  tags: string;
  phraseFields: string[];
  preview: string;
  firstTextOffsets: Map<string, number>;
  defaultSnippet: string;
}

interface ParsedQuery {
  loose: string[];
  phrases: string[];
  exclusions: string[];
  title: string;
}

function normalize(term: string): string {
  return term.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function tokenize(text: string): string[] {
  return (text.match(WORD) ?? []).map(normalize);
}

// Punctuation separates words. Quotes require consecutive words within one field;
// a leading minus excludes exact words or a quoted phrase, never fuzzy matches.
// An unfinished quote consumes the remainder. Empty clauses fail closed rather
// than disappearing, as do oversized queries (which are never truncated).
function parseQuery(query: string): ParsedQuery | null {
  if (query.length > MAX_QUERY_LENGTH) return null;

  const loose: string[] = [];
  const phrases: string[] = [];
  const exclusions: string[] = [];
  const positive: string[] = [];
  let count = 0;
  let cursor = 0;

  while (cursor < query.length) {
    if (/\s/u.test(query[cursor])) {
      cursor++;
      continue;
    }

    const excluded = query[cursor] === '-';
    if (excluded) cursor++;
    const quoted = query[cursor] === '"';
    let value: string;

    if (quoted) {
      const start = ++cursor;
      const closing = query.indexOf('"', start);
      cursor = closing === -1 ? query.length : closing;
      value = query.slice(start, cursor);
      if (closing !== -1) cursor++;
    } else {
      const start = cursor;
      while (cursor < query.length && !/[\s"]/u.test(query[cursor])) cursor++;
      value = query.slice(start, cursor);
    }

    const terms = tokenize(value);
    count += terms.length;
    if (terms.length === 0 || count > MAX_QUERY_TERMS) return null;

    if (excluded) {
      if (quoted) exclusions.push(` ${terms.join(' ')} `);
      else for (const term of terms) exclusions.push(` ${term} `);
    } else {
      positive.push(...terms);
      if (quoted) phrases.push(terms.join(' '));
      else loose.push(...terms);
    }
  }

  return { loose, phrases, exclusions, title: positive.join(' ') };
}

function snippetAround(text: string, matchOffset = 0): string {
  if (text.length <= SNIPPET_LENGTH) return text;

  let start = Math.max(0, matchOffset - 55);
  if (start > 0) {
    const boundary = text.indexOf(' ', start);
    if (boundary !== -1 && boundary < matchOffset && boundary - start < 25) start = boundary + 1;
  }
  // Avoid cutting a surrogate pair even in long, unbroken Unicode words.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start--;

  let end = Math.min(text.length, start + SNIPPET_LENGTH - 2);
  if (end < text.length) {
    const boundary = text.lastIndexOf(' ', end);
    if (boundary > Math.max(start + 90, matchOffset)) end = boundary;
    if (/[\uDC00-\uDFFF]/u.test(text[end])) end--;
  }

  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function prepareEntry(source: SearchEntry, id: number): PreparedEntry {
  const title = tokenize(source.title).join(' ');
  const tags = source.tags.map((tag) => tokenize(tag).join(' '));
  const preview = source.text.replace(/\s+/gu, ' ').trim();
  const firstTextOffsets = new Map<string, number>();
  const textTerms: string[] = [];

  for (const match of preview.matchAll(WORD)) {
    const term = normalize(match[0]);
    textTerms.push(term);
    if (!firstTextOffsets.has(term)) firstTextOffsets.set(term, match.index);
  }

  const text = textTerms.join(' ');
  return {
    id,
    source,
    title,
    text,
    tags: tags.join(' '),
    // Separate tag boundaries prevent phrases from spanning unrelated tags.
    phraseFields: [title, text, ...tags].map((field) => ` ${field} `),
    preview,
    firstTextOffsets,
    defaultSnippet: snippetAround(preview),
  };
}

function makeHit(document: PreparedEntry, score: number, terms: string[]): SearchHit {
  let firstMatch = Infinity;
  for (const term of terms) {
    const offset = document.firstTextOffsets.get(term);
    if (offset !== undefined && offset < firstMatch) firstMatch = offset;
  }

  return {
    ...document.source,
    score,
    terms,
    snippet: firstMatch === Infinity
      ? document.defaultSnippet
      : snippetAround(document.preview, firstMatch),
  };
}

export function createSearchIndex(entries: SearchEntry[]): SearchIndex {
  const documents = entries.map(prepareEntry);
  const index = new MiniSearch<PreparedEntry>({
    fields: ['title', 'text', 'tags'],
    // Fields and queries are normalized once before reaching MiniSearch.
    tokenize: (text) => text.split(' '),
    processTerm: (term) => term || null,
    searchOptions: {
      combineWith: 'AND',
      boost: { title: 12, tags: 4, text: 1 },
      prefix: (term) => term.length >= 2,
      fuzzy: (term) => term.length < 4 ? false : term.length < 8 ? 1 : 2,
      maxFuzzy: 2,
      weights: { prefix: 0.75, fuzzy: 0.4 },
    },
  });
  index.addAll(documents);

  return {
    search(query, kind = 'all') {
      const parsed = parseQuery(query);
      if (!parsed) return [];

      const requiredPhrases = parsed.phrases.map((phrase) => ` ${phrase} `);
      const accepts = (document: PreparedEntry): boolean =>
        (kind === 'all' || document.source.kind === kind)
        && requiredPhrases.every((phrase) => document.phraseFields.some((field) => field.includes(phrase)))
        && !parsed.exclusions.some((phrase) => document.phraseFields.some((field) => field.includes(phrase)));

      // No positive terms means source order, including exclusion-only searches.
      // Iterate directly instead of manufacturing and sorting wildcard matches.
      if (parsed.title === '') {
        const hits: SearchHit[] = [];
        for (const document of documents) {
          if (accepts(document)) hits.push(makeHit(document, 0, []));
        }
        return hits;
      }

      const queries: Query[] = [];
      if (parsed.loose.length > 0) queries.push(parsed.loose.join(' '));
      if (parsed.phrases.length > 0) {
        queries.push({
          queries: parsed.phrases,
          combineWith: 'AND',
          prefix: false,
          fuzzy: false,
        });
      }

      const results = index.search({ combineWith: 'AND', queries }, {
        filter: (result) => accepts(documents[result.id]),
      });
      // A complete exact title always outranks incidental body matches, even
      // when corpus-dependent BM25 weights alone would favor the latter.
      const titleBoost = (results[0]?.score ?? 0) + 1;
      for (const result of results) {
        if (documents[result.id].title === parsed.title) result.score += titleBoost;
      }
      results.sort((a, b) => b.score - a.score || a.id - b.id);
      return results.map((result) => makeHit(documents[result.id], result.score, result.terms));
    },
  };
}
