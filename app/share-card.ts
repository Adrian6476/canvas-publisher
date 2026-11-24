import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

const app = new App({ name: "Canvas share link", version: "1.0.0" });
const link = document.querySelector<HTMLAnchorElement>("#open")!;
const copy = document.querySelector<HTMLButtonElement>("#copy")!;
const address = document.querySelector<HTMLInputElement>("#address")!;
const status = document.querySelector<HTMLElement>("#status")!;
const expectedOrigin = decodeURIComponent(document.body.dataset.publicOrigin ?? "");

function shareUrl(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("id" in data) || !("url" in data)) return;
  if (typeof data.id !== "string" || typeof data.url !== "string") return;
  let url: URL;
  try {
    url = new URL(data.url);
  } catch {
    return;
  }
  if (url.origin !== expectedOrigin || url.pathname !== `/c/${data.id}` ||
    url.username || url.password || url.search || url.hash) return;
  return url.href;
}

app.ontoolresult = (result) => {
  const url = result.isError ? undefined : shareUrl(result.structuredContent);
  link.toggleAttribute("hidden", !url);
  copy.toggleAttribute("hidden", !url);
  address.hidden = true;
  address.value = url ?? "";
  if (url) {
    link.href = url;
    status.textContent = "Anyone with the link can view.";
  } else {
    link.removeAttribute("href");
    status.textContent = "No published canvas link was returned.";
  }
};

link.addEventListener("click", (event) => {
  if (!link.hasAttribute("href") || !app.getHostCapabilities()?.openLinks) return;
  event.preventDefault();
  void app.openLink({ url: link.href }).then((result) => {
    if (result.isError) status.textContent = "Could not open the link here. Copy it to open in a browser.";
  }).catch(() => {
    status.textContent = "Could not open the link here. Copy it to open in a browser.";
  });
});

copy.addEventListener("click", () => {
  if (!address.value) return;
  // Sandboxed frames can lack Clipboard API permission. Leave a selected URL
  // available for manual copying if the browser blocks the copy command.
  address.hidden = false;
  address.select();
  if (document.execCommand("copy")) {
    address.hidden = true;
    copy.focus();
    status.textContent = "Link copied.";
  } else {
    status.textContent = "Copy the selected link.";
  }
});

app.onteardown = () => ({});
void app.connect().catch(() => {
  status.textContent = "The canvas link card could not connect.";
});
