import { build } from "esbuild";

const card = await build({
  entryPoints: ["app/share-card.ts"],
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  loader: { ".png": "dataurl" },
  write: false,
});
const cardScript = card.outputFiles[0].text.replace(/<\/script/giu, "<\\/script");

await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  platform: "browser",
  external: ["node:*"],
  loader: { ".png": "dataurl" },
  outfile: "dist/worker.js",
  define: { __CANVAS_SHARE_CARD_SCRIPT__: JSON.stringify(cardScript) },
  logLevel: "info",
});
