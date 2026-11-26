import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authenticate } from "./auth";
import { CanvasError, CanvasService, MAX_HTML_BYTES } from "./canvas";
import { shareCard, shareCardMimeType, shareCardToolMeta, shareCardUri } from "./share-card";

const maxRequestBytes = 2 * 1024 * 1024;
const revision = z.number().int().positive();
const reference = z.string().trim().min(1).max(2048).describe("Canvas ID or share URL.");
const title = z.string().trim().min(1).max(160);
const html = z.string().min(1).max(MAX_HTML_BYTES).describe("Complete self-contained HTML, up to 256 KiB in UTF-8.");
const expectedPublication = revision.nullable().optional()
  .describe("Last known published revision. Use null if unpublished. Omit for an unconditional action.");
const shareFields = {
  html,
  request_id: z.string().min(1).max(128).describe("A unique ID for this share operation. Reuse it with the same arguments on retry."),
};
const shareInput = z.object({
  ...shareFields, id: reference.optional(), base_revision: revision.optional(),
  title: title.optional(), expected_published_revision: expectedPublication,
}).superRefine((args, ctx) => {
  if (args.id === undefined) {
    if (args.title === undefined || args.base_revision !== undefined || args.expected_published_revision !== undefined) {
      ctx.addIssue({ code: "custom", message: "A new canvas requires a title and no revision fields." });
    }
  } else if (args.base_revision === undefined) {
    ctx.addIssue({ code: "custom", message: "Sharing an edit requires the latest base_revision." });
  }
});
const shareOutput = { id: z.uuid(), published_revision: revision, url: z.url() };

function shareLinkContent(data: { url: string }): CallToolResult["content"] {
  return [
    { type: "text", text: JSON.stringify(data) },
    { type: "text", text: `[Open canvas](${data.url})` },
  ];
}

async function result<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
  format = (data: T): CallToolResult["content"] => [{ type: "text", text: JSON.stringify(data) }],
): Promise<CallToolResult> {
  try {
    const data = await operation();
    return { structuredContent: data, content: format(data) };
  } catch (error) {
    if (!(error instanceof CanvasError)) {
      console.error(JSON.stringify({ event: "canvas_tool_failed" }));
      return { isError: true, content: [{ type: "text", text: "Canvas operation failed." }] };
    }
    const data = { code: error.code, message: error.message };
    return { isError: true, structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
  }
}

function makeServer(service: CanvasService): McpServer {
  const server = new McpServer({ name: "canvas-publisher", version: "0.1.0" }, {
    instructions: "Use canvas_share when delivering a finished Canvas report or updating its shared link. It saves and publishes in one call. Anyone with the returned URL can view it. Copy that URL exactly. MCP tools only manage the authenticated owner's canvases. Use canvas_create and canvas_update for draft work. An existing draft can be published with canvas_publish.",
  });

  server.registerResource("canvas-share-link", shareCardUri, {
    title: "Canvas share link",
    mimeType: shareCardMimeType,
  }, () => ({
    contents: [{ uri: shareCardUri, mimeType: shareCardMimeType, text: shareCard(service.publicOrigin) }],
  }));

  server.registerTool("canvas_share", {
    description: "Deliver a finished HTML canvas at an anonymous share URL. Omit id to create with a title, or pass id and the latest base_revision to publish an edit at the same URL. Return the URL from this tool.",
    inputSchema: shareInput,
    outputSchema: shareOutput,
    annotations: { idempotentHint: true, openWorldHint: true },
    _meta: shareCardToolMeta,
  }, ({ id, base_revision, title, expected_published_revision, ...fields }) => result(
    () => id === undefined
      ? service.share({ ...fields, title: title! })
      : service.share({ ...fields, id, title, base_revision: base_revision!, expected_published_revision }),
    shareLinkContent,
  ));

  server.registerTool("canvas_create", {
    description: "Save a new canvas as a draft. Use canvas_share to deliver a finished canvas, or canvas_publish to publish a saved revision.",
    inputSchema: {
      title, html,
      request_id: z.string().min(1).max(128).optional().describe("Reuse the same ID if retrying this creation."),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ title, html, request_id }) => result(() => service.create(title, html, request_id)));

  server.registerTool("canvas_get", {
    description: "Retrieve source and revision for a canvas you own. By default, retrieve the latest draft.",
    inputSchema: { id: reference, revision: revision.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ id, revision }) => result(() => service.get(id, revision)));

  server.registerTool("canvas_update", {
    description: "Save a new draft on an existing canvas using its latest known revision. The public link keeps its published revision.",
    inputSchema: { id: reference, base_revision: revision, html, title: title.optional() },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ id, base_revision, html, title }) => result(() => service.update(id, base_revision, html, title)));

  server.registerTool("canvas_publish", {
    description: "Make an exact revision public at the canvas's stable share URL. Publishing an older revision restores it.",
    inputSchema: { id: reference, revision, expected_published_revision: expectedPublication },
    outputSchema: shareOutput,
    annotations: { idempotentHint: true, openWorldHint: true },
    _meta: shareCardToolMeta,
  }, ({ id, revision, expected_published_revision }) => result(
    () => service.publish(id, revision, expected_published_revision), shareLinkContent,
  ));

  server.registerTool("canvas_unpublish", {
    description: "Remove anonymous access to a canvas. Retain the draft history so it can be published again.",
    inputSchema: { id: reference, expected_published_revision: expectedPublication },
    annotations: { idempotentHint: true, openWorldHint: true },
  }, ({ id, expected_published_revision }) => result(() => service.unpublish(id, expected_published_revision)));

  return server;
}

function rpcError(status: number, code: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers });
}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("Content-Length")) > maxRequestBytes) throw new RangeError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0;
  let source = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxRequestBytes) {
        await reader.cancel();
        throw new RangeError();
      }
      source += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(source + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export async function serveMcp(
  request: Request, db: D1Database, publicOrigin: string, credentials: string | undefined,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return rpcError(403, -32000, "Origin is not allowed.");
  }
  const principal = await authenticate(request, credentials);
  if (!principal) {
    return rpcError(401, -32000, "Bearer authentication required.", { "WWW-Authenticate": "Bearer" });
  }
  if (request.method !== "POST") {
    return rpcError(405, -32000, "Use POST.", { Allow: "POST" });
  }
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return rpcError(415, -32000, "Use application/json.");
  }

  let body: unknown;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error instanceof RangeError) return rpcError(413, -32000, "Request is too large.");
    return rpcError(400, -32700, "Invalid JSON.");
  }
  const server = makeServer(new CanvasService(db, publicOrigin, principal));
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    await server.close();
  }
}
