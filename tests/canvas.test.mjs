import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localClientToken, startLocalRuntime } from "../scripts/local-runtime.mjs";

let local;
let client;
const secondClientToken = "second-client-test-token-for-local-use-only";
const friendClientToken = "friend-client-test-token-for-local-use-only";

before(async () => {
  local = await startLocalRuntime({
    clients: {
      local: { token: localClientToken, owner_id: "owner" },
      second: { token: secondClientToken, owner_id: "owner" },
      friend: { token: friendClientToken, owner_id: "friend" },
    },
  });
  client = new Client({ name: "canvas-tests", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", local.apiOrigin), {
    requestInit: { headers: { Authorization: `Bearer ${localClientToken}` } },
  }));
});

after(async () => {
  await client?.close();
  await local?.runtime.dispose();
});

async function tool(name, args, connection = client) {
  const result = await connection.callTool({ name: `canvas_${name}`, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

test("MCP creates a draft and retrieves the submitted HTML", async () => {
  const created = await tool("create", { title: "Interactive chart", html: "<h1>First chart</h1>" });
  const draft = await tool("get", { id: created.id });
  assert.equal(draft.revision, 1);
  assert.equal(draft.html, "<h1>First chart</h1>");
  assert.equal(draft.published_revision, null);
});

function toolErrorCode(result) {
  return (result.structuredContent ?? JSON.parse(result.content[0].text)).code;
}

async function failedTool(name, args, code, connection = client) {
  const result = await connection.callTool({ name: `canvas_${name}`, arguments: args });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(toolErrorCode(result), code, JSON.stringify(result));
}

function publicRequest(path, options) {
  return fetch(new URL(path, local.publicOrigin), options);
}

test("the same link advances only on publication and can roll back or be withdrawn", async () => {
  const created = await tool("create", { title: "Report", html: "<h1>First</h1>" });
  const path = `/c/${created.id}`;
  const render = `/render/${created.id}`;
  assert.equal((await publicRequest(path)).status, 404);
  assert.equal((await publicRequest(render)).status, 404);

  await failedTool("publish", { id: created.id, revision: 2 }, "NOT_FOUND");
  const first = await tool("publish", { id: created.id, revision: 1, expected_published_revision: null });
  assert.equal(first.url, local.publicOrigin + path);
  const share = await publicRequest(path);
  assert.equal(share.status, 200);
  assert.equal(share.headers.get("cache-control"), "no-store");
  assert.equal(share.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await share.text(), /sandbox="allow-scripts"/);
  assert.equal(await (await publicRequest(render)).text(), "<h1>First</h1>");

  const other = new Client({ name: "second-agent", version: "1.0.0" });
  let updated;
  try {
    await other.connect(new StreamableHTTPClientTransport(new URL("/mcp", local.apiOrigin), {
      requestInit: { headers: { Authorization: `Bearer ${secondClientToken}` } },
    }));
    updated = await tool("update", { id: first.url, base_revision: 1, html: "<h1>Second</h1>" }, other);
  } finally {
    await other.close();
  }
  assert.equal(updated.revision, 2);
  assert.equal((await tool("get", { id: first.url })).html, "<h1>Second</h1>");
  assert.equal(await (await publicRequest(render)).text(), "<h1>First</h1>");
  await failedTool("publish", { id: first.url, revision: 2, expected_published_revision: null }, "PUBLICATION_CONFLICT");
  const second = await tool("publish", { id: first.url, revision: 2, expected_published_revision: 1 });
  assert.equal(second.url, first.url);
  assert.equal(await (await publicRequest(render)).text(), "<h1>Second</h1>");
  await tool("publish", { id: created.id, revision: 1, expected_published_revision: 2 });
  assert.equal(await (await publicRequest(render)).text(), "<h1>First</h1>");

  await tool("unpublish", { id: first.url, expected_published_revision: 1 });
  for (const entry of [path, render]) {
    const response = await publicRequest(entry);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await tool("get", { id: created.id })).revision, 2);
});

test("concurrent edits produce one revision and one conflict", async () => {
  const { id } = await tool("create", { title: "Concurrent edit", html: "<p>Original</p>" });
  const edits = ["<p>Choice A</p>", "<p>Choice B</p>"];
  const results = await Promise.all(edits.map((html) => client.callTool({
    name: "canvas_update",
    arguments: { id, base_revision: 1, html },
  })));
  assert.equal(results.filter((result) => result.isError).length, 1);
  assert.equal(results.find((result) => result.isError).structuredContent?.code, "REVISION_CONFLICT");
  const draft = await tool("get", { id });
  assert.equal(draft.revision, 2);
  assert.equal(draft.html, edits[results.findIndex((result) => !result.isError)]);
});

test("a retried create with the same request ID preserves identity", async () => {
  const args = { title: "One canvas", html: "<p>Original</p>", request_id: "retry-test" };
  const first = await tool("create", args);
  await tool("update", { id: first.id, base_revision: 1, html: "<p>Edited</p>" });
  assert.deepEqual(await tool("create", args), first);
  const another = await tool("create", { title: args.title, html: args.html });
  assert.notEqual(another.id, first.id);
  await failedTool("create", { ...args, html: "<p>Different</p>" }, "REQUEST_ID_REUSED");
});

test("save sizes use UTF-8 bytes and share references stay on this service", async () => {
  await failedTool("create", { title: "Too large", html: "汉".repeat(90000) }, "HTML_TOO_LARGE");
  await failedTool("get", { id: "https://elsewhere.invalid/c/d1fd5a02-9d29-4c09-9820-4145a6496ef6" }, "INVALID_REFERENCE");
});

test("anonymous and cross-origin MCP requests cannot access a canvas", async () => {
  const url = new URL("/mcp", local.apiOrigin);
  const response = await fetch(url, { method: "POST" });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  const authorized = { Authorization: `Bearer ${localClientToken}` };
  assert.equal((await fetch(url, {
    method: "POST", headers: { ...authorized, Origin: "https://external.invalid" },
  })).status, 403);
  assert.equal((await fetch(url, {
    method: "POST", headers: { Authorization: "Bearer a-wrong-token-with-enough-characters" },
  })).status, 401);
  assert.equal((await publicRequest("/mcp", { method: "POST", headers: authorized })).status, 404);
  const apiShare = new URL("/c/d1fd5a02-9d29-4c09-9820-4145a6496ef6", local.apiOrigin);
  assert.equal((await fetch(apiShare, { headers: authorized })).status, 404);
  assert.equal((await fetch(url, {
    method: "POST",
    headers: { ...authorized, "Content-Type": "application/json" },
    body: "{}" + " ".repeat(2 * 1024 * 1024),
  })).status, 413);

});

test("Chromium runs inline interactions inside the sandbox and blocks API requests", async () => {
  const { chromium } = await import("playwright");
  const title = 'Demo "<script>"';
  const html = `<!doctype html><button onclick="this.textContent='Clicked'">Click me</button>
    <output id="security">Waiting</output>
    <script>
      (async () => {
        const checks = [];
        try { void parent.document.body; } catch (error) { checks.push(error.name); }
        try { localStorage.setItem("private", "no"); } catch (error) { checks.push(error.name); }
        try { await fetch("/mcp"); } catch (error) { checks.push(error.name); }
        document.getElementById("security").textContent = checks.join(",");
      })();
    </script>`;
  const { id } = await tool("create", { title, html });
  const { url } = await tool("publish", { id, revision: 1 });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    assert.equal(await page.title(), title);
    const frame = page.frameLocator("iframe");
    const button = frame.getByRole("button");
    await button.click();
    assert.equal(await button.textContent(), "Clicked");
    await frame.getByText("SecurityError,SecurityError,TypeError").waitFor();
    const directResponse = await page.goto(new URL(`/render/${id}`, local.publicOrigin).href);
    assert.match(directResponse.headers()["content-security-policy"], /sandbox allow-scripts/);
    assert.equal(await page.evaluate(() => self.origin), "null");
  } finally {
    await browser.close();
  }
});

test("one MCP call publishes a canvas and returns its working anonymous link", async () => {
  const html = "<h1>Sample report</h1>";
  const args = { title: "Sample report", html, request_id: "share-new-test" };
  const result = await client.callTool({ name: "canvas_share", arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const share = result.structuredContent;
  assert.equal(share.published_revision, 1);
  assert.equal(share.url, `${local.publicOrigin}/c/${share.id}`);
  assert.ok(result.content.some((block) => block.type === "text" && block.text.includes(share.url)));
  const page = await publicRequest(share.url);
  assert.equal(page.status, 200);
  const render = await publicRequest(`/render/${share.id}`);
  assert.equal(render.status, 200);
  assert.equal(await render.text(), html);
  assert.deepEqual(await tool("share", args), share);
});

test("share requires a title for a new canvas and a base revision for edits", async () => {
  const created = await tool("create", { title: "Sample draft", html: "<h1>Unpublished</h1>" });
  for (const args of [
    { html: "<h1>No title</h1>", request_id: "share-missing-title" },
    { id: created.id, html: "<h1>No base revision</h1>", request_id: "share-missing-base" },
  ]) {
    const result = await client.callTool({ name: "canvas_share", arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.url, undefined);
  }
  assert.equal((await publicRequest(`/c/${created.id}`)).status, 404);
});

test("sharing an edit preserves the link and rejects stale or conflicting writes", async () => {
  const args = { title: "Sample report", html: "<h1>First revision</h1>", request_id: "share-edit-first" };
  const first = await tool("share", args);
  const edit = {
    id: first.url, base_revision: 1, expected_published_revision: 1,
    html: "<h1>Second revision</h1>", request_id: "share-edit-second",
  };
  const competingEdit = { ...edit, html: "<h1>Competing revision</h1>", request_id: "share-edit-competing" };
  const [firstResult, competingResult] = await Promise.all([edit, competingEdit].map((arguments_) => client.callTool({
    name: "canvas_share", arguments: arguments_,
  })));
  const winner = firstResult.isError ? competingEdit : edit;
  const winningResult = firstResult.isError ? competingResult : firstResult;
  const losingResult = firstResult.isError ? firstResult : competingResult;
  assert.equal(winningResult.isError, undefined);
  assert.equal(toolErrorCode(losingResult), "REVISION_CONFLICT");
  const second = winningResult.structuredContent;
  assert.deepEqual(second, { id: first.id, published_revision: 2, url: first.url, title: "Sample report" });
  assert.deepEqual(await tool("share", { ...winner, id: first.id }), second);
  await failedTool("share", { ...winner, html: "<h1>Different content</h1>" }, "REQUEST_ID_REUSED");
  await failedTool("share", { ...winner, base_revision: 2, request_id: "share-stale-publication" }, "PUBLICATION_CONFLICT");
  assert.equal(await (await publicRequest(`/render/${first.id}`)).text(), winner.html);
  assert.equal((await tool("get", { id: first.id })).latest_revision, 2);

  await tool("unpublish", { id: first.id, expected_published_revision: 2 });
  await failedTool("share", winner, "PUBLICATION_CHANGED");
  assert.equal((await publicRequest(first.url)).status, 404);
});

test("the share tool advertises a self-contained MCP App card", async () => {
  const { tools } = await client.listTools();
  for (const name of ["canvas_share", "canvas_publish"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool.outputSchema?.properties?.url);
    const uri = tool._meta?.ui?.resourceUri;
    assert.match(uri ?? "", /^ui:\/\//u);
    const { contents } = await client.readResource({ uri });
    assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(contents[0].text, /Open canvas/u);
  }
});

test("the MCP App opens the exact published link without a model reply", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const listing = await client.listTools();
  const definition = listing.tools.find((entry) => entry.name === "canvas_share");
  const { contents: [card] } = await client.readResource({ uri: definition._meta.ui.resourceUri });
  const result = await client.callTool({ name: definition.name, arguments: {
    title: "Card browser test", html: "<h1>Sample report from the card</h1>", request_id: "share-card-browser",
    summary: "Open the sample report.",
    card: { layout: "feature", accent: "teal", highlights: ["Sample fact"], action_label: "Read sample" },
  } });
  assert.equal(result.isError, undefined);
  const { outputFiles: [host] } = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
        window.mountCard = async ({ html, result }) => {
          const frame = document.querySelector("iframe");
          const bridge = new AppBridge(null, { name: "Canvas test host", version: "1.0.0" }, { openLinks: {} },
            { hostContext: { theme: "dark", locale: "en-US" } });
          bridge.oninitialized = () => { void bridge.sendToolResult(result); };
          bridge.onopenlink = async ({ url }) => {
            window.open(url, "_blank", "noopener,noreferrer");
            return {};
          };
          await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
          frame.srcdoc = html;
          window.sendCardResult = (data) => bridge.sendToolResult(data);
          window.setCardTheme = (theme) => bridge.sendHostContextChange({ theme });
        };
      `,
    },
    bundle: true, platform: "browser", format: "iife", write: false,
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    await page.setContent('<iframe title="Canvas card" style="width:100%; height:300px; border:0" sandbox="allow-scripts allow-downloads allow-popups"></iframe>');
    await page.addScriptTag({ content: host.text });
    await page.evaluate(({ html, toolResult }) => window.mountCard({ html, result: toolResult }), {
      html: card.text, toolResult: result,
    });
    const frame = page.frameLocator('iframe[title="Canvas card"]');
    const link = frame.getByRole("link", { name: "Read sample" });
    await link.waitFor();
    await frame.getByRole("heading", { name: "Card browser test" }).waitFor();
    await frame.getByText("Open the sample report.").waitFor();
    await frame.getByText("Sample fact").waitFor();
    const main = frame.locator("main");
    assert.equal(await main.getAttribute("data-layout"), "feature");
    assert.equal(await main.getAttribute("data-accent"), "teal");
    assert.equal(await frame.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await main.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
    const darkBackground = await main.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => window.setCardTheme("light"));
    await frame.locator('html[data-theme="light"]').waitFor();
    assert.notEqual(await main.evaluate((el) => getComputedStyle(el).backgroundColor), darkBackground);
    assert.equal(await link.getAttribute("href"), result.structuredContent.url);
    const [popup] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
    await popup.frameLocator("iframe").getByRole("heading", { name: "Sample report from the card" }).waitFor();
    const copy = frame.getByRole("button", { name: "Copy link" });
    await copy.click();
    const status = (await frame.getByRole("status").textContent()) ?? "";
    assert.match(status, /^(Link copied\.|Copy the selected link\.)$/u);
    if (status === "Copy the selected link.") {
      assert.equal(await frame.getByRole("textbox", { name: "Canvas share URL" }).inputValue(), result.structuredContent.url);
    }

    await page.evaluate(({ id }) => window.sendCardResult({
      content: [], structuredContent: { id, url: "https://external.invalid/c/" + id, published_revision: 1 },
    }), result.structuredContent);
    await frame.getByText("No published canvas link was returned.").waitFor();
    assert.equal(await link.count(), 0);
    await page.evaluate(() => window.sendCardResult({
      isError: true, content: [{ type: "text", text: '{"message":"The published version changed."}' }],
    }));
    await frame.getByText("The published version changed.").waitFor();
    assert.equal(await link.count(), 0);

    const { id, url, published_revision } = result.structuredContent;
    await page.evaluate((legacy) => window.sendCardResult({ content: [], structuredContent: legacy }), {
      id, url, published_revision,
    });
    await frame.getByRole("heading", { name: "Canvas" }).waitFor();
    assert.equal(await frame.getByRole("link", { name: "Open canvas" }).getAttribute("href"), url);
  } finally {
    await browser.close();
  }
});

test("an owner credential only manages canvases belonging to that owner", async () => {
  const friend = new Client({ name: "friend-agent", version: "1.0.0" });
  try {
    await friend.connect(new StreamableHTTPClientTransport(new URL("/mcp", local.apiOrigin), {
      requestInit: { headers: { Authorization: `Bearer ${friendClientToken}` } },
    }));
    const args = { title: "Owner report", html: "<h1>Owner report</h1>", request_id: "isolation-share" };
    const own = await tool("share", args);
    const theirs = await tool("share", { ...args, html: "<h1>Friend report</h1>" }, friend);
    assert.notEqual(own.id, theirs.id);
    const draft = await tool("update", { id: own.id, base_revision: 1, html: "<p>Owner draft</p>" });
    assert.equal(draft.revision, 2);
    for (const [operation, parameters] of [
      ["get", { id: own.url }],
      ["get", { id: own.id, revision: 1 }],
      ["update", { id: own.id, base_revision: 2, html: "<p>Foreign edit</p>" }],
      ["share", { id: own.url, base_revision: 2, html: "<p>Foreign share</p>", request_id: "isolation-foreign" }],
      ["publish", { id: own.id, revision: 2 }],
      ["unpublish", { id: own.url }],
    ]) {
      await failedTool(operation, parameters, "NOT_FOUND", friend);
    }
    await failedTool("get", { id: theirs.id }, "NOT_FOUND");
    assert.equal((await tool("get", { id: theirs.id }, friend)).html, "<h1>Friend report</h1>");
    assert.equal((await tool("get", { id: own.id })).latest_revision, 2);
    for (const canvas of [own, theirs]) assert.equal((await publicRequest(canvas.url)).status, 200);
    assert.equal(await (await publicRequest(`/render/${own.id}`)).text(), args.html);
  } finally {
    await friend.close();
  }
});

test("MCP rejects ambiguous token assignments and credentials without an owner", async () => {
  const duplicateToken = "duplicate-token-for-local-ownership-test";
  const legacyToken = "legacy-unassigned-token-for-local-test";
  const malformedMap = {
    valid: { token: localClientToken, owner_id: "owner" },
    legacy: legacyToken,
  };
  const ambiguousMap = {
    valid: { token: localClientToken, owner_id: "owner" },
    first: { token: duplicateToken, owner_id: "owner" },
    second: { token: duplicateToken, owner_id: "friend" },
  };
  for (const [clients, rejected] of [[malformedMap, legacyToken], [ambiguousMap, duplicateToken]]) {
    const testRuntime = await startLocalRuntime({ clients });
    try {
      const response = await fetch(new URL("/mcp", testRuntime.apiOrigin), {
        method: "POST", headers: { Authorization: `Bearer ${rejected}` },
      });
      assert.equal(response.status, 401);
    } finally {
      await testRuntime.runtime.dispose();
    }
  }
});

test("published revisions carry caller-selected card content and browser metadata", async () => {
  const args = {
    title: "Sample travel report", html: "<h1>Sample travel report</h1>", request_id: "presentation-v1",
    summary: "Compare two ferry routes.", favicon: "travel",
    card: { layout: "feature", accent: "teal", highlights: ["Two ferry routes"], action_label: "Read report" },
  };
  const first = await tool("share", args);
  assert.equal(first.title, args.title);
  assert.equal(first.summary, args.summary);
  assert.equal(first.favicon, args.favicon);
  assert.deepEqual(first.card, args.card);
  const original = await (await publicRequest(first.url)).text();
  assert.match(original, /<title>Sample travel report<\/title>/u);
  const icon = original.match(/<link rel="icon" href="(data:image\/png;base64,[^"]+)"/u)?.[1];
  assert.ok(icon);
  await failedTool("share", { ...args, summary: "Changed summary" }, "REQUEST_ID_REUSED");

  const { revision } = await tool("update", {
    id: first.id, base_revision: 1, title: "Sample chart", html: "<h1>Chart</h1>",
    summary: null, favicon: "chart", card: { layout: "compact" },
  });
  assert.equal(await (await publicRequest(first.url)).text(), original);
  const second = await tool("publish", { id: first.id, revision });
  assert.equal(second.title, "Sample chart");
  assert.equal(second.summary, undefined);
  assert.deepEqual(second.card, { ...args.card, layout: "compact" });
  const changed = await (await publicRequest(first.url)).text();
  assert.match(changed, /<title>Sample chart<\/title>/u);
  assert.ok(changed.includes('rel="icon"'));
  assert.ok(!changed.includes(icon));
  const rollback = await tool("publish", { id: first.id, revision: 1 });
  assert.deepEqual(rollback, first);
  assert.equal(await (await publicRequest(first.url)).text(), original);
});
