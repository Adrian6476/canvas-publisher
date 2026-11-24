import { localClientToken, startLocalRuntime } from "./local-runtime.mjs";

const port = Number(process.env.PORT ?? 8787);
const { runtime, apiOrigin, publicOrigin } = await startLocalRuntime({ port, persistent: true });
console.log(`MCP endpoint ${apiOrigin}/mcp`);
console.log(`Public canvas origin ${publicOrigin}`);
console.log(`Local-only test token ${localClientToken}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await runtime.dispose();
  });
}
