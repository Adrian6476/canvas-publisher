# Canvas Publisher

Publish a self-contained HTML canvas at a stable, anonymous share URL. Agents use an authenticated MCP server to edit drafts, publish a specific revision, roll back or withdraw a link. All authorized clients belong to one owner and can edit the same canvases.

## Local development

Use Node.js 22 or newer, pnpm and curl. Install the Chromium browser for the browser integration test.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm typecheck
pnpm test
pnpm dev
```

The dev runtime listens on loopback. It prints the MCP endpoint at `http://127.0.0.1:8787/mcp`, a public viewer at `http://localhost:8787` and a local test credential. Its SQLite-backed D1 emulator persists files under `.miniflare/`. The tests and default benchmark each create an isolated database.

## MCP tools

| Tool | Behavior |
| --- | --- |
| `canvas_create` | Create revision 1 as a private draft. Reuse a supplied `request_id` to retry a creation safely. |
| `canvas_get` | Read the latest draft or a specific revision by canvas ID or share URL. |
| `canvas_update` | Save new HTML against the last read `base_revision`. Optionally change the title. |
| `canvas_publish` | Publish a revision and get its stable URL. To roll back, publish an earlier revision. |
| `canvas_unpublish` | Withdraw public access and retain the revision history. |

Set `expected_published_revision` on publish or withdrawal when acting on a previously read state. Use `null` when the canvas was unpublished at the time of the read. Save, publish and withdrawal operations are atomic. Any authorized client can read and edit any draft. Give each client a distinct credential so its access can be revoked individually.

A canvas accepts up to 256 KiB of UTF-8 HTML. The viewer runs inline scripts and styles inside an opaque-origin iframe. Images can use data or blob URLs and fonts can use data URLs. The browser policy blocks external scripts, fetch, form submission and navigation of the top-level viewer by embedded content. A viewer exposes the HTML source to anyone with the link. Public links opt out of search indexing and are served without caching.

## Cloudflare deployment

Production runs on the `canvas-publisher` Worker, the `canvas-publisher` D1 database and two Worker Custom Domains. Viewers use `https://canvas.adrian6476.top/c/<id>`. Agents use `https://canvas-api.adrian6476.top/mcp` with Streamable HTTP and a Bearer header. Keep the OpenWebUI connection scoped to the owner.

Build and validate the Cloudflare Build Output locally with the Cloudflare CLI. Use cf 1.0.0-rc.4 with Node.js 22.23 or a supported newer version.

```sh
pnpm package
cf deploy --prebuilt --dry-run --no-provision
```

In an authorized Cloudflare account, create the D1 database once and save its returned ID as `CANVAS_D1_ID`. Use a credential with permission to manage this Worker, its D1 database and its custom domains.

```sh
cf d1 create --name canvas-publisher --read-replication-mode disabled --primary-location-hint apac
cf d1 migrations apply "$CANVAS_D1_ID" --dir migrations
CANVAS_D1_ID="$CANVAS_D1_ID" pnpm package
cf deploy --prebuilt --no-provision --secrets-file "$CANVAS_SECRETS_FILE"
```

Supply a private JSON secrets file outside the repository. Set `CANVAS_CLIENT_TOKENS` to a JSON **string** containing an object keyed by client name. Its values are distinct high-entropy tokens, such as 32 random bytes encoded as hex. When rotating access, update the secret with the current client map. The production configuration disables `workers.dev` and preview URLs. The deployment host holds the database ID and the secrets file in `~/.config/canvas-publisher/`.

## Direct latency

```sh
pnpm bench
```

The default measures local loopback without a proxy. It records curl DNS, TCP and TLS completion, TTFB and total time for the share page, its iframe HTML and the two MCP discovery requests. Each endpoint gets one unreported warmup followed by 30 samples, each on a fresh connection. The benchmark tests the service path after the runtime starts.

For a deployed instance, set `CANVAS_BENCH_API` to the HTTPS MCP URL, `CANVAS_BENCH_TOKEN` to a client credential and `CANVAS_BENCH_URL` to an existing published HTTPS share URL. The remote mode makes read-only calls and disables curl proxy use. Set `CANVAS_BENCH_INTERFACE` if you need to bind curl to a specific interface. A transparent VPN or tunnel can still influence the host route.

### Production sample on 2026-11-24

Measured from the home Ubuntu host through its physical network interface with curl proxies disabled. Each row has 30 successful HTTPS requests on fresh connections. The median time to finish TLS was 478–488 ms. A separate response-header check reached Cloudflare's Amsterdam edge (AMS).

| Endpoint | TTFB p50 (ms) | TTFB p95 (ms) |
| --- | ---: | ---: |
| Public share page | 1073.35 | 2823.03 |
| Published HTML | 982.62 | 3334.13 |
| MCP initialize | 768.71 | 1715.32 |
| MCP tools/list | 772.36 | 3082.55 |

The public page and iframe HTML are separate requests. These timings measure each endpoint independently. The temporary benchmark canvas was withdrawn and both public paths returned HTTP 404.
