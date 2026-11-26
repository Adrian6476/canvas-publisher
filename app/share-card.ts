import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { Presentation } from "../src/presentation";

type ShareResult = Presentation & { id: string; url: string; title?: string };
type CardStatus = "waiting" | "missing" | "connection" | "openFailed" | "manualCopy";

const english = {
  open: "Open canvas",
  copy: "Copy link",
  copied: "Link copied.",
  copiedLabel: "Copied",
  waiting: "Waiting for the canvas link…",
  missing: "No published canvas link was returned.",
  connection: "The canvas link card could not connect.",
  openFailed: "Could not open the link here. Copy it to open in a browser.",
  manualCopy: "Copy the selected link.",
};
const chinese = {
  open: "打开画布",
  copy: "复制链接",
  copied: "链接已复制。",
  copiedLabel: "已复制",
  waiting: "正在加载画布链接…",
  missing: "未返回已发布的画布链接。",
  connection: "画布卡片连接失败。",
  openFailed: "无法直接打开。请复制链接到浏览器打开。",
  manualCopy: "请复制已选中的链接。",
};

const app = new App({ name: "Canvas share link", version: "1.0.0" });
const card = document.querySelector<HTMLElement>("#card")!;
const delivery = document.querySelector<HTMLElement>("#delivery")!;
const title = document.querySelector<HTMLElement>("#title")!;
const summary = document.querySelector<HTMLElement>("#summary")!;
const highlights = document.querySelector<HTMLElement>("#highlights")!;
const link = document.querySelector<HTMLAnchorElement>("#open")!;
const openLabel = document.querySelector<HTMLElement>("#open-label")!;
const copy = document.querySelector<HTMLButtonElement>("#copy")!;
const address = document.querySelector<HTMLInputElement>("#address")!;
const status = document.querySelector<HTMLElement>("#status")!;
const expectedOrigin = decodeURIComponent(document.body.dataset.publicOrigin ?? "");

let labels = english;
let actionLabel: string | undefined;
let statusKey: CardStatus | undefined = "waiting";
let toolError = "";
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

function syncHostContext() {
  const context = app.getHostContext();
  const locale = context?.locale ?? navigator.language;
  document.documentElement.lang = locale;
  document.documentElement.dataset.theme = context?.theme ?? "";
  labels = /^zh(?:-|$)/iu.test(locale) ? chinese : english;
  openLabel.textContent = actionLabel ?? labels.open;
  copy.textContent = copiedTimer ? labels.copiedLabel : labels.copy;
  status.textContent = toolError || (copiedTimer ? labels.copied : statusKey ? labels[statusKey] : "");
}

function shareResult(value: unknown): ShareResult | undefined {
  if (!value || typeof value !== "object" || !("id" in value) || !("url" in value)) return;
  if (typeof value.id !== "string" || typeof value.url !== "string") return;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return;
  }
  if (url.origin !== expectedOrigin || url.pathname !== `/c/${value.id}` ||
    url.username || url.password || url.search || url.hash) return;
  return { ...value, id: value.id, url: url.href };
}

function setStatus(key?: CardStatus) {
  clearTimeout(copiedTimer);
  copiedTimer = undefined;
  statusKey = key;
  syncHostContext();
}

function errorMessage(value: unknown) {
  return value && typeof value === "object" && "message" in value && typeof value.message === "string"
    ? value.message : "";
}

app.ontoolresult = (result) => {
  const details = result.isError ? undefined : shareResult(result.structuredContent);
  toolError = "";
  if (result.isError) {
    toolError = errorMessage(result.structuredContent);
    const block = result.content?.find((item) => item.type === "text");
    if (!toolError && block?.type === "text") {
      try {
        toolError = errorMessage(JSON.parse(block.text));
      } catch {
        toolError = block.text;
      }
    }
  }
  address.hidden = true;
  address.value = details?.url ?? "";
  delivery.hidden = !details;
  if (!details) {
    link.removeAttribute("href");
    setStatus("missing");
    return;
  }
  card.dataset.layout = details.card?.layout ?? "compact";
  card.dataset.accent = details.card?.accent ?? "neutral";
  title.textContent = details.title || "Canvas";
  summary.textContent = details.summary ?? "";
  summary.hidden = !details.summary;
  highlights.replaceChildren();
  for (const highlight of details.card?.highlights ?? []) {
    const item = document.createElement("li");
    item.dir = "auto";
    item.textContent = highlight;
    highlights.append(item);
  }
  highlights.hidden = !highlights.childElementCount;
  actionLabel = details.card?.action_label;
  link.href = details.url;
  setStatus();
};

link.addEventListener("click", (event) => {
  if (!link.hasAttribute("href") || !app.getHostCapabilities()?.openLinks) return;
  event.preventDefault();
  void app.openLink({ url: link.href }).then((result) => {
    if (result.isError) setStatus("openFailed");
  }).catch(() => setStatus("openFailed"));
});

copy.addEventListener("click", () => {
  if (!address.value) return;
  // Sandboxed frames can lack Clipboard API permission. Leave the selected
  // address visible for manual copying if the browser blocks the command.
  address.hidden = false;
  address.select();
  if (document.execCommand("copy")) {
    address.hidden = true;
    copy.focus();
    setStatus();
    copiedTimer = setTimeout(() => setStatus(), 1800);
    syncHostContext();
  } else {
    setStatus("manualCopy");
  }
});

app.onhostcontextchanged = syncHostContext;
app.onteardown = () => {
  clearTimeout(copiedTimer);
  return {};
};
void app.connect().then(syncHostContext).catch(() => setStatus("connection"));
