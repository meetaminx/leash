import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        app: resolve(import.meta.dirname, "app/index.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
      },
    },
  },
});
