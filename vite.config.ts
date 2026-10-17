import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative URLs so the app works from any path prefix.
  base: './',
  build: {
    target: 'es2022',
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
