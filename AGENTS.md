# Canvas Publisher

The Worker serves anonymous HTML at the public origin and authenticated Streamable HTTP MCP at the API origin. Both use the same D1 database. `src/canvas.ts` owns revision and publication behavior, `src/mcp.ts` adapts it to MCP, and `src/public.ts` serves the sandboxed viewer.

Save a new immutable revision on edits and keep the published pointer separate. Preserve compare-and-swap behavior for concurrent edits and keep public reads bound to the published pointer. Treat generated HTML as untrusted, including when its render URL is opened directly. Keep the public routes uncached and credentials out of logs, tool responses and source control.

Run `pnpm typecheck`, `pnpm test` and `pnpm package` before deployment. Use `pnpm bench` for direct latency measurements. The default benchmark uses an isolated local D1 database. See the README for testing on a deployed Worker.
