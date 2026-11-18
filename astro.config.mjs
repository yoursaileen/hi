import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://yoursaileen.github.io',
  base: '/hi',
  vite: {
    plugins: [tailwindcss()],
  },
});
