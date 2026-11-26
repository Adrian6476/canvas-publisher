# Canvas Publisher

The Worker serves anonymous HTML at the public origin and authenticated Streamable HTTP MCP at the API origin. Both use the same D1 database. `src/canvas.ts` owns revision and publication behavior, `src/mcp.ts` adapts it to MCP, and `src/public.ts` serves the sandboxed viewer.

Production uses the `canvas-publisher` Cloudflare Worker and D1 database. The public origin is `canvas.adrian6476.top` and the MCP origin is `canvas-api.adrian6476.top`. Both are Worker Custom Domains served directly by Cloudflare.

On the deployment host, private state belongs in `~/.config/canvas-publisher/`. The Cloudflare location and database IDs are in `deployment.json`, and `worker-secrets.json` contains the per-client credential map. Keep the directory at mode 0700 and both files at 0600. Use the documented deployment commands with the existing database ID for updates.

The home OpenWebUI administrator uses the private `canvas-publisher` connection. CC Switch uses one separate credential for its shared `canvas-publisher` entry and syncs it to Claude Code, Codex, OpenCode and Hermes. Keep the MCP connection and client credential mapping private.

Every management request runs as the owner derived from its bearer credential. Keep all management queries scoped to that owner, including revision lookups, mutations and retries. Return `NOT_FOUND` for foreign canvases. Anonymous serving reads only the published version. Migration `0003_canvas_ownership.sql` assigns existing canvases to `owner`. Keep existing credential names and values when adding their explicit `owner_id` assignments. Follow the README deployment sequence before enrolling other owners.

Save a new immutable revision on edits and keep the published pointer separate. Preserve compare-and-swap behavior for concurrent edits and keep public reads bound to the published pointer. Treat generated HTML as untrusted, including when its render URL is opened directly. Keep the public routes uncached and credentials out of logs, tool responses and source control.

Keep `canvas_share` atomic and preserve its request ID behavior when changing revisions or publishing. The MCP result is the source of the share URL. The card in `app/share-card.ts` renders that link through MCP Apps and uses a static UI resource built into the Worker. Keep real canvases and private deployment details in their private locations. Use synthetic HTML in fixtures.

Run `pnpm typecheck`, `pnpm test` and `pnpm package` before deployment. Use `pnpm bench` for direct latency measurements. The default benchmark uses an isolated local D1 database. See the README for testing on a deployed Worker.
