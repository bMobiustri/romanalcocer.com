// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://romanalcocer.com',
  trailingSlash: 'never',
  build: { format: 'file' },
});
