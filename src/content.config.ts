import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Essays are markdown files in src/content/essays/.
// Minimum frontmatter: title, date. Everything else optional.
const essays = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/essays' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    summary: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { essays };
