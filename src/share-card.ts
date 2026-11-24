declare const __CANVAS_SHARE_CARD_SCRIPT__: string;

export const shareCardUri = "ui://canvas-publisher/share-link.html";
export const shareCardMimeType = "text/html;profile=mcp-app";
export const shareCardToolMeta = { ui: { resourceUri: shareCardUri, visibility: ["model"] } };

export function shareCard(publicOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 14px system-ui, sans-serif; color: CanvasText; }
    main { margin: 4px; padding: 12px; border: 1px solid GrayText; border-radius: 8px; }
    p { margin: 0; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; }
    nav:has(:not([hidden])) { margin-top: 8px; }
    a, button { font: inherit; color: LinkText; }
    button { cursor: pointer; }
    input { box-sizing: border-box; width: 100%; margin-top: 8px; font: inherit; }
  </style>
</head>
<body data-public-origin="${encodeURIComponent(publicOrigin)}">
  <main>
    <p id="status" role="status">Waiting for the canvas link…</p>
    <nav aria-label="Share actions">
      <a id="open" target="_blank" rel="noopener noreferrer" hidden>Open canvas</a>
      <button type="button" id="copy" hidden>Copy link</button>
    </nav>
    <input id="address" aria-label="Canvas share URL" readonly hidden>
  </main>
  <script>${__CANVAS_SHARE_CARD_SCRIPT__}</script>
</body>
</html>`;
}
