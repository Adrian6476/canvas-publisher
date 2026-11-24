import { CanvasService, canvasIdPattern } from "./canvas";

const sharePath = new RegExp(`^/(c|render)/(${canvasIdPattern})/?$`, "u");
const wrapperPolicy = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const renderPolicy = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function wrapper(id: string, title: string): string {
  const label = title.replace(/[&<>"']/gu, (character) => entities[character]);
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${label}</title>
<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>
<iframe title="${label}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/render/${id}"></iframe>
</html>`;
}

export async function servePublic(request: Request, path: string, service: CanvasService): Promise<Response> {
  const matched = sharePath.exec(path);
  if (!matched) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const [, route, id] = matched;
  const render = route === "render";
  const published = await service.readPublished(id, render ? "html" : "title");
  if (published === null) return new Response("Not found", { status: 404 });
  const body = render ? published : wrapper(id, published);
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": render ? renderPolicy : wrapperPolicy,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
  });
}
