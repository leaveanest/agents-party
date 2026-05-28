import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const siteRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: siteRoot,
  base: "/agents-party/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(siteRoot, "index.html"),
        en: resolve(siteRoot, "en/index.html"),
        quickStart: resolve(siteRoot, "pages/quick-start.html"),
        architecture: resolve(siteRoot, "pages/architecture.html"),
        enQuickStart: resolve(siteRoot, "en/pages/quick-start.html"),
        enArchitecture: resolve(siteRoot, "en/pages/architecture.html"),
      },
    },
  },
});
