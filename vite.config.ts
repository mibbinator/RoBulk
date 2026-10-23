import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Content scripts can't be ES modules, so the whole extension UI is bundled
// into one self-contained IIFE. Files in public/ (manifest, icons) are copied
// to dist/ as-is; load dist/ as an unpacked extension.
export default defineConfig(({ mode }) => ({
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: mode === "development" ? "inline" : false,
    minify: mode !== "development",
    lib: {
      entry: "src/content/main.tsx",
      name: "RoBulk",
      formats: ["iife"],
      fileName: () => "content.js",
    },
  },
  test: {
    environment: "node",
  },
}));
