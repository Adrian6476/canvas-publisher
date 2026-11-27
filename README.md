# Canvas Publisher

Publish a self-contained HTML canvas at a stable, anonymous share URL. Agents use an authenticated MCP server to edit drafts, publish a specific revision, roll back or withdraw a link. Each owner manages their own canvases across their authorized clients.

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
| `canvas_share` | Save and publish a finished canvas in one call. Omit `id` and provide `title` to create. To publish an edit at the same URL, pass `id` and the last read `base_revision`. |
| `canvas_create` | Create revision 1 as a private draft. Reuse a supplied `request_id` to retry a creation safely. |
| `canvas_get` | Read the latest draft or a specific revision by canvas ID or share URL. |
| `canvas_update` | Save new HTML against the last read `base_revision`. Optionally change the title. |
| `canvas_publish` | Publish a revision and get its stable URL. To roll back, publish an earlier revision. |
| `canvas_unpublish` | Withdraw public access and retain the revision history. |

Use `canvas_share` when delivering a finished report or updating its public link. Provide a unique `request_id` and reuse it with the same arguments when retrying that request. A retry confirms the original revision if it is still published. If another operation has since withdrawn or replaced it, Canvas reports the changed state.

Use the returned `url` as the share link. MCP Apps clients such as OpenWebUI display open and copy actions for successful shares and publications. The same results include the link as text for clients without MCP Apps support.

### Presentation

`canvas_share`, `canvas_create` and `canvas_update` accept these optional presentation fields alongside `title` and `html`.

| Field | Use |
| --- | --- |
| `title` | Name the actual deliverable in the reader's language. The card and browser tab use this title. |
| `summary` | Optional sentence with up to 180 characters explaining what the reader will get. |
| `favicon` | Choose `canvas`, `document`, `chart`, `travel` or `code` for the browser tab. Set it explicitly for a new canvas. Use `document` for general reports. |
| `card.layout` | Choose `compact` for a simple delivery, `feature` for an overview with key facts, or `editorial` for a long-form report. |
| `card.accent` | Choose `neutral`, `blue`, `teal`, `violet` or `amber`. |
| `card.icon` | Choose from the same icons to override the delivery card icon. By default, the card uses the browser favicon. Both use the Canvas icon when no icon is set. |
| `card.highlights` | Include up to three useful facts of at most 80 characters each. |
| `card.action_label` | Provide up to 24 characters for the primary action, such as “View itinerary”. |

Use a clear hierarchy and responsive, accessible styling in the self-contained report HTML. Canvas applies the card layout and colors and adapts to the host's light or dark theme. Presentation settings are saved with each revision. On edits, omitted settings carry forward and `null` clears a setting or all card options. The published revision determines the current browser tab title and icon. Each result card shows the information returned for its publication.

Set `expected_published_revision` on a share edit, publish or withdrawal when acting on a previously read state. Use `null` when the canvas was unpublished at the time of the read. Save, publish and withdrawal operations are atomic.

A canvas accepts up to 256 KiB of UTF-8 HTML. The viewer runs inline scripts and styles inside an opaque-origin iframe. Images can use data or blob URLs and fonts can use data URLs. The browser policy blocks external scripts, fetch, form submission and navigation of the top-level viewer by embedded content. A viewer exposes the HTML source to anyone with the link. Public links opt out of search indexing and are served without caching.

## Owners and credentials

A credential identifies one owner. Give a person a stable owner ID and a distinct credential for each client they use. Clients assigned to the same owner can manage that owner's canvases. MCP returns `NOT_FOUND` for canvases belonging to another owner, even when given their share URL. Anyone with a published link can still open the published revision in a browser.

Store `CANVAS_CLIENT_TOKENS` as a JSON string in the deployment secrets file. The decoded object maps credential names to a `token` and explicit `owner_id`. Names and owner IDs use 1–64 lowercase alphanumerics, hyphens or underscores. Use a different random token for each entry, such as 32 random bytes encoded as hex. Rotate a token by replacing its value while keeping the credential name and owner ID. Remove an entry to revoke that credential. Do not recycle owner IDs for another person.

```json
{
  "primary-client": {"owner_id": "owner", "token": "<unique-token-for-this-client>"},
  "friend-client": {"owner_id": "friend-a", "token": "<different-unique-token>"}
}
```

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

For updates, reuse the existing D1 database ID and apply pending migrations before uploading the Worker. Migration `0002_share_requests.sql` adds share retry tracking to existing revision records.

Migration `0003_canvas_ownership.sql` assigns all existing canvases to the reserved owner ID `owner`. Back up the private secrets file and convert each existing entry from a token string to an object with its same token and `"owner_id": "owner"`. Keep the credential names to preserve the existing retry receipts. Apply the migration, then upload the Worker and the converted secrets file together. Verify access with an existing client before provisioning any additional owners. Once additional owners have canvases, use an ownership-aware Worker version for any rollback.

Migration `0004_canvas_presentation.sql` adds optional presentation fields to revisions. Older revisions use the default card and favicon. Share requests without presentation fields retain their original retry receipts.

Supply a private JSON secrets file outside the repository. The production configuration disables `workers.dev` and preview URLs. The deployment host holds the database ID and the secrets file in `~/.config/canvas-publisher/`.

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
