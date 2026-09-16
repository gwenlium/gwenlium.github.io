import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const permalinkPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function calendarDate(value: string | Date | undefined): Date {
  const text = value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString().replace(/T00:00:00\.000Z$/, '')
    : value;
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(NaN);
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text
    ? date
    : new Date(NaN);
}

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string().default(''),
    permalink: z.string().default(''),
    date: z.union([z.string(), z.date()]).optional().transform(calendarDate),
    excerpt: z.string().optional(),
    draft: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
    cover: z.string().default(''),
    coverAlt: z.string().default(''),
    featured: z.boolean().default(false),
    media: z.array(z.object({
      type: z.enum(['image', 'video', 'audio']).default('image'),
      src: z.string().default(''),
      alt: z.string().default(''),
      caption: z.string().default(''),
      poster: z.string().default(''),
    })).default([]),
  }).superRefine((post, context) => {
    // Unfinished excluded entries must not stop the public site from building.
    if (post.draft || post.date.getTime() > Date.now()) return;
    const required = (path: string, message: string) => {
      context.addIssue({ code: 'custom', path: [path], message });
    };
    if (!post.title.trim()) required('title', 'Published posts need a title.');
    if (!permalinkPattern.test(post.permalink)) {
      required('permalink', 'Use a unique lowercase slug with single hyphens between words.');
    }
    if (!Number.isFinite(post.date.getTime())) {
      required('date', 'Use a valid ISO calendar date: YYYY-MM-DD.');
    }
    if (post.excerpt === undefined) {
      required('excerpt', 'Include your own excerpt, or an empty string.');
    }
  }).transform((post) => ({ ...post, excerpt: post.excerpt ?? '' })),
});

export const collections = { posts };
