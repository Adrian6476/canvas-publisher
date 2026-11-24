import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CanvasError, CanvasService, MAX_HTML_BYTES } from "./canvas";

const maxRequestBytes = 2 * 1024 * 1024;
const revision = z.number().int().positive();
const reference = z.string().trim().min(1).max(2048).describe("Canvas ID or share URL.");
const title = z.string().trim().min(1).max(160);
const html = z.string().min(1).max(MAX_HTML_BYTES).describe("Complete self-contained HTML, up to 256 KiB in UTF-8.");
const expectedPublication = revision.nullable().optional()
  .describe("Last known published revision. Use null if unpublished. Omit for an unconditional action.");

async function result(operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const data = await operation();
    return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (error) {
    if (!(error instanceof CanvasError)) {
      console.error(JSON.stringify({ event: "canvas_tool_failed" }));
      return { isError: true, content: [{ type: "text", text: "Canvas operation failed." }] };
    }
    const data = { code: error.code, message: error.message };
    return { isError: true, structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
  }
}

function makeServer(service: CanvasService, client: string): McpServer {
  const server = new McpServer({ name: "canvas-publisher", version: "0.1.0" }, {
    instructions: "Create a draft for a new canvas. To edit an existing canvas, read it and save against its latest revision. Publish only when the user asks to share or update a public link.",
  });

  server.registerTool("canvas_create", {
    description: "Create a new private canvas draft. Call canvas_publish to get a public link.",
    inputSchema: {
      title, html,
      request_id: z.string().min(1).max(128).optional().describe("Reuse the same ID if retrying this creation."),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ title, html, request_id }) => result(() => service.create(client, title, html, request_id)));

  server.registerTool("canvas_get", {
    description: "Retrieve canvas source and its revision. By default, retrieve the latest draft.",
    inputSchema: { id: reference, revision: revision.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ id, revision }) => result(() => service.get(id, revision)));

  server.registerTool("canvas_update", {
    description: "Save a new draft on an existing canvas using its latest known revision. The public link keeps its published revision.",
    inputSchema: { id: reference, base_revision: revision, html, title: title.optional() },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ id, base_revision, html, title }) => result(() => service.update(client, id, base_revision, html, title)));

  server.registerTool("canvas_publish", {
    description: "Make an exact revision public at the canvas's stable share URL. Publishing an older revision restores it.",
    inputSchema: { id: reference, revision, expected_published_revision: expectedPublication },
    annotations: { idempotentHint: true, openWorldHint: true },
  }, ({ id, revision, expected_published_revision }) => result(() => service.publish(id, revision, expected_published_revision)));

  server.registerTool("canvas_unpublish", {
    description: "Remove anonymous access to a canvas. Retain the draft history so it can be published again.",
    inputSchema: { id: reference, expected_published_revision: expectedPublication },
    annotations: { idempotentHint: true, openWorldHint: true },
  }, ({ id, expected_published_revision }) => result(() => service.unpublish(id, expected_published_revision)));

  return server;
}

const tokenFormat = /^[A-Za-z0-9_-]{24,256}$/u;
const encoder = new TextEncoder();

export async function authenticate(request: Request, credentials: string | undefined): Promise<string | undefined> {
  const supplied = /^Bearer (\S+)$/iu.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!credentials || !supplied || !tokenFormat.test(supplied)) return;
  const clients: unknown = JSON.parse(credentials);
  if (!clients || typeof clients !== "object" || Array.isArray(clients)) return;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(supplied));
  let matched: string | undefined;
  for (const [name, token] of Object.entries(clients)) {
    if (typeof token !== "string" || !tokenFormat.test(token) || !/^[a-z0-9_-]{1,64}$/u.test(name)) continue;
    const expected = await crypto.subtle.digest("SHA-256", encoder.encode(token));
    if (crypto.subtle.timingSafeEqual(digest, expected)) matched = name;
  }
  return matched;
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

export async function serveMcp(request: Request, service: CanvasService, credentials: string | undefined): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return rpcError(403, -32000, "Origin is not allowed.");
  }
  const client = await authenticate(request, credentials);
  if (!client) {
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
  const server = makeServer(service, client);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    await server.close();
  }
}
