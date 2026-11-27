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
    :root[data-theme="light"] { color-scheme: light; }
    :root[data-theme="dark"] { color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0; padding: 4px; font: 14px/1.45 Inter, system-ui, sans-serif; }
    main {
      --ink: light-dark(#172033, #f4f5fa);
      --muted: light-dark(#4b586d, #b5bfd0);
      --line: light-dark(#dce2ea, #384257);
      --surface: light-dark(#fbfcfe, #1a2231);
      --tint: light-dark(#ecf0f6, #263246);
      --accent: light-dark(#30425d, #c2d0e5);
      --action: light-dark(white, #131c29);
      color: var(--ink);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 13px;
      padding: 13px 15px;
      container-type: inline-size;
    }
    main[data-accent="blue"] {
      --tint: light-dark(#eaf2ff, #223554); --accent: light-dark(#214ca8, #b3ccff);
    }
    main[data-accent="teal"] {
      --tint: light-dark(#e6f5f1, #1c3b3a); --accent: light-dark(#09645a, #9ae0d3);
    }
    main[data-accent="violet"] {
      --tint: light-dark(#f0eaff, #392c53); --accent: light-dark(#6231a4, #d3baff);
    }
    main[data-accent="amber"] {
      --tint: light-dark(#fff2db, #413420); --accent: light-dark(#8a490a, #ffd187);
    }
    .delivery { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px 11px; align-items: start; }
    .mark {
      display: grid; place-items: center; background: var(--tint);
      inline-size: 36px; block-size: 36px; border-radius: 10px;
    }
    .mark img { inline-size: 26px; block-size: 26px; }
    h1, p, ul { margin: 0; overflow-wrap: anywhere; }
    h1 { font-size: 1rem; line-height: 1.35; font-weight: 650; letter-spacing: -0.015em; }
    #summary { color: var(--muted); margin-top: 3px; font-size: .875rem; }
    #highlights { color: var(--muted); margin-top: 6px; padding-inline-start: 1.15rem; font-size: .8125rem; }
    #highlights li + li { margin-top: 2px; }
    nav { display: flex; flex-wrap: wrap; gap: 5px 9px; grid-column: 2; align-items: center; }
    a, button {
      max-inline-size: 100%; min-block-size: 36px; padding: 6px 10px; border-radius: 7px;
      border: 1px solid transparent; font: 600 .8125rem/1.35 Inter, system-ui, sans-serif;
      overflow-wrap: anywhere; text-decoration: none; cursor: pointer;
    }
    a { display: inline-flex; align-items: center; gap: 4px; color: var(--action); background: var(--accent); }
    a:hover { text-decoration: underline; }
    button { color: var(--accent); background: transparent; }
    button:hover { background: var(--tint); }
    a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    #status:not(:empty) { color: var(--muted); font-size: .8125rem; }
    .delivery:not([hidden]) + #status:not(:empty) { margin-top: 8px; }
    input {
      margin-top: 8px; width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 6px;
      background: var(--surface); color: var(--ink); font: inherit;
    }
    main[data-layout="feature"] { background: var(--tint); padding: 16px; }
    main[data-layout="feature"] .mark { background: var(--surface); }
    main[data-layout="feature"] h1 { font-size: 1.125rem; }
    main[data-layout="feature"] nav { margin-top: 2px; }
    main[data-layout="editorial"] { border-inline-start: 3px solid var(--accent); }
    main[data-layout="editorial"] h1 { font: 650 1.2rem/1.25 Georgia, serif; }
    main[data-layout="editorial"] .mark { background: transparent; }
    @container (min-width: 440px) {
      main[data-layout="compact"] .delivery { grid-template-columns: auto minmax(0, 1fr) auto; }
      main[data-layout="compact"] nav { grid-column: 3; justify-content: flex-end; max-inline-size: 16rem; }
    }
    @container (max-width: 300px) {
      nav { grid-column: 1 / -1; }
      a, button { min-block-size: 44px; }
    }
  </style>
</head>
<body data-public-origin="${encodeURIComponent(publicOrigin)}">
  <main id="card" data-layout="compact" data-accent="neutral">
    <div id="delivery" class="delivery" hidden>
      <span class="mark" aria-hidden="true"><img id="icon" alt="" width="26" height="26"></span>
      <div>
        <h1 id="title" dir="auto">Canvas</h1>
        <p id="summary" dir="auto" hidden></p>
        <ul id="highlights" hidden></ul>
      </div>
      <nav aria-label="Share actions">
        <a id="open" target="_blank" rel="noopener noreferrer"><bdi id="open-label">Open canvas</bdi> <span aria-hidden="true">↗</span></a>
        <button type="button" id="copy">Copy link</button>
      </nav>
    </div>
    <p id="status" role="status">Waiting for the canvas link…</p>
    <input id="address" aria-label="Canvas share URL" readonly hidden>
  </main>
  <script>${__CANVAS_SHARE_CARD_SCRIPT__}</script>
</body>
</html>`;
}
