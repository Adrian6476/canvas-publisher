import { serveMcp } from "./mcp";
import { servePublic } from "./public";

interface CanvasBindings {
  DB: D1Database;
  API_ORIGIN: string;
  PUBLIC_ORIGIN: string;
  CANVAS_CLIENT_TOKENS?: string;
}

export default {
  async fetch(request, bindings): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;

    try {
      if (url.origin === bindings.API_ORIGIN && url.pathname === "/mcp") {
        response = await serveMcp(request, bindings.DB, bindings.PUBLIC_ORIGIN, bindings.CANVAS_CLIENT_TOKENS);
      } else if (url.origin === bindings.PUBLIC_ORIGIN) {
        response = await servePublic(request, url.pathname, bindings.DB);
      } else {
        response = new Response("Not found", { status: 404 });
      }
    } catch {
      console.error(JSON.stringify({ event: "canvas_request_failed" }));
      response = new Response("Internal server error", { status: 500 });
    }

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<CanvasBindings>;
