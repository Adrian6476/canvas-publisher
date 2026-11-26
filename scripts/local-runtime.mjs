import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import workerd from "workerd";

process.env.MINIFLARE_WORKERD_PATH ??= workerd.default;

export const localClientToken = "local-test-token-for-canvas-development-only";

export async function startLocalRuntime({
  port = 0,
  persistent = false,
  clients = { local: { token: localClientToken, owner_id: "owner" } },
} = {}) {
  // Use separate hostnames for the public and MCP surfaces on the same loopback server.
  const config = {
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    compatibilityDate: "2026-11-24",
    host: "127.0.0.1",
    port,
    d1Databases: { DB: "canvas-local" },
    d1Persist: persistent ? fileURLToPath(new URL("../.miniflare/", import.meta.url)) : false,
    bindings: {
      CANVAS_CLIENT_TOKENS: JSON.stringify(clients),
    },
  };
  // Use Miniflare's assigned port in both origin bindings.
  const runtime = new Miniflare(config);
  try {
    const address = await runtime.ready;
    const apiOrigin = address.origin;
    const publicOrigin = `http://localhost:${address.port}`;
    await runtime.setOptions({
      ...config,
      port: Number(address.port),
      bindings: {
        ...config.bindings,
        API_ORIGIN: apiOrigin,
        PUBLIC_ORIGIN: publicOrigin,
      },
    });
    const db = await runtime.getD1Database("DB");
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      await db.prepare("CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)").run();
      const applied = await db.prepare("SELECT 1 FROM local_migrations WHERE name = ?").bind(name).first();
      if (applied) continue;
      const statements = sql.split(";").map((part) => part.trim()).filter(Boolean);
      await db.batch([
        ...statements.map((statement) => db.prepare(statement)),
        db.prepare("INSERT INTO local_migrations VALUES (?)").bind(name),
      ]);
    }
    return { runtime, apiOrigin, publicOrigin };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
