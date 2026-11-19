import { defineConfig } from 'vite';

// Build-time only. Output goes to ./build, which manifest.yml uses as the resource path.
export default defineConfig({
  base: './', // relative asset URLs: Forge serves the resource from a sub-path
  build: {
    outDir: 'build',
    emptyOutDir: true,
    target: 'esnext',
    minify: false, // community reports of minifiers mangling bridge globals; size is irrelevant here
  },
});
