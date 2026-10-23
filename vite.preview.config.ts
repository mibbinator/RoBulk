import { copyFileSync } from "node:fs";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Builds the preview page (the panel on fake data) as a plain script so it
// also works when opened straight from disk.
export default defineConfig({
  plugins: [
    preact(),
    { name: "copy-preview-html", closeBundle: () => copyFileSync("preview/index.html", "dist-preview/index.html") },
  ],
  publicDir: false,
  build: {
    outDir: "dist-preview",
    emptyOutDir: true,
    minify: false,
    lib: { entry: "preview/preview.tsx", name: "RoBulkPreview", formats: ["iife"], fileName: () => "preview.js" },
  },
});
