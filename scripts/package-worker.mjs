import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getWorkerBundleDir,
  readBuildOutput,
  writeRootConfig,
  writeWorkerConfig,
} from "@cloudflare/build-output-utils";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicHost = "canvas.adrian6476.top";
const apiHost = "canvas-api.adrian6476.top";
const databaseId = process.env.CANVAS_D1_ID;
if (databaseId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(databaseId)) {
  throw new Error("CANVAS_D1_ID must be a D1 database UUID.");
}

const bundle = getWorkerBundleDir(root);
await mkdir(bundle, { recursive: true });
await copyFile(join(root, "dist/worker.js"), join(bundle, "worker.js"));
await writeRootConfig({ root, buildContext: { isPreview: false, mode: "production" } });
await writeWorkerConfig({
  root,
  config: {
    name: "canvas-publisher",
    compatibilityDate: "2026-11-24",
    domains: [publicHost, apiHost],
    workersDev: false,
    previewUrls: false,
    env: {
      DB: { type: "d1", name: "canvas-publisher", id: databaseId },
      API_ORIGIN: { type: "text", value: `https://${apiHost}` },
      PUBLIC_ORIGIN: { type: "text", value: `https://${publicHost}` },
      CANVAS_CLIENT_TOKENS: { type: "secret" },
    },
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true },
      traces: { enabled: true, headSamplingRate: 0.01 },
    },
  },
  manifest: { type: "complete", mainModule: "worker.js", modules: { "worker.js": { type: "esm" } } },
});
await readBuildOutput(root);
console.log("Cloudflare Build Output is ready in .cloudflare/output/v1.");
