import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localClientToken, startLocalRuntime } from "../scripts/local-runtime.mjs";

let local;
let client;
const secondClientToken = "second-client-test-token-for-local-use-only";

before(async () => {
  local = await startLocalRuntime({
    clients: { local: localClientToken, second: secondClientToken },
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

async function failedTool(name, args, code) {
  const result = await client.callTool({ name: `canvas_${name}`, arguments: args });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.code, code, JSON.stringify(result));
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
