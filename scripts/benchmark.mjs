import { spawn } from "node:child_process";

const repetitions = Number(process.env.CANVAS_BENCH_SAMPLES ?? 30);
const protocol = "2025-11-25";

function rpc(method, params) {
  return { jsonrpc: "2.0", id: 1, method, params };
}

function curl(url, { token, body, responseBody = false } = {}) {
  const args = ["-q", "--noproxy", "*", "--silent", "--show-error", "--max-time", "15"];
  if (process.env.CANVAS_BENCH_INTERFACE) args.push("--interface", process.env.CANVAS_BENCH_INTERFACE);
  const headers = [];
  if (token !== undefined) {
    if (!/^[A-Za-z0-9_-]{24,256}$/u.test(token)) throw new Error("Invalid benchmark token format.");
    headers.push(`Authorization: Bearer ${token}`, "Accept: application/json, text/event-stream",
      "Content-Type: application/json", `Mcp-Protocol-Version: ${protocol}`);
    args.push("--header", "@-");
  }
  if (body !== undefined) args.push("--data-binary", JSON.stringify(body));
  args.push(
    "--output", responseBody ? "-" : "/dev/null",
    "--write-out", "%{stderr}\n%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{remote_ip}",
    "--url", url,
  );

  return new Promise((resolve, reject) => {
    const request = spawn("curl", args);
    let stdout = "";
    let stderr = "";
    request.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    request.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    request.on("error", reject);
    request.stdin.on("error", () => {}); // curl can exit before consuming stdin on connection failures.
    request.on("close", (code) => {
      const [status, dns, tcp, tls, ttfb, total, ip] = stderr.trim().split(/\s+/u);
      if (code !== 0 || status !== "200") {
        reject(new Error(`Direct request to ${url} failed (curl ${code}): ${stderr.trim()}`));
      } else {
        const toMilliseconds = (value) => Number(value) * 1000;
        resolve({
          body: stdout,
          ip,
          dns: toMilliseconds(dns),
          tcp: toMilliseconds(tcp),
          tls: toMilliseconds(tls),
          ttfb: toMilliseconds(ttfb),
          total: toMilliseconds(total),
        });
      }
    });
    request.stdin.end(headers.join("\n") + "\n");
  });
}

async function call(api, token, method, params) {
  const { body } = await curl(api, { token, body: rpc(method, params), responseBody: true });
  const response = JSON.parse(body);
  if (!response.result || response.result.isError) throw new Error(`MCP ${method} failed.`);
  return response.result;
}

async function bench(label, run) {
  await run();
  const samples = [];
  for (let index = 0; index < repetitions; index++) samples.push(await run());
  const percentile = (field, quantile) => {
    const sorted = samples.map((row) => row[field]).sort((a, b) => a - b);
    return Number(sorted[Math.ceil(quantile * sorted.length) - 1].toFixed(2));
  };
  return {
    endpoint: label,
    requests: samples.length,
    remote: [...new Set(samples.map((sample) => sample.ip))].join(", "),
    "DNS p50 ms": percentile("dns", 0.5),
    "TCP ready p50 ms": percentile("tcp", 0.5),
    "TLS ready p50 ms": percentile("tls", 0.5),
    "TTFB p50 ms": percentile("ttfb", 0.5),
    "TTFB p95 ms": percentile("ttfb", 0.95),
    "Total p95 ms": percentile("total", 0.95),
  };
}

async function measure(api, publicUrl, token) {
  const initialize = rpc("initialize", {
    protocolVersion: protocol, capabilities: {}, clientInfo: { name: "canvas-bench", version: "0.1.0" },
  });
  const server = await call(api, token, initialize.method, initialize.params);
  const tools = await call(api, token, "tools/list", {});
  if (server.serverInfo?.name !== "canvas-publisher" || !tools.tools?.some(({ name }) => name === "canvas_get")) {
    throw new Error("The benchmark endpoint does not expose the Canvas MCP tools.");
  }
  const render = new URL(publicUrl);
  if (!/^\/c\/[^/]+\/?$/u.test(render.pathname)) throw new Error("Use a published canvas share URL.");
  render.pathname = render.pathname.replace(/^\/c\//u, "/render/");
  const rows = [
    await bench("Public share page", () => curl(publicUrl)),
    await bench("Published HTML", () => curl(render.href)),
    await bench("MCP initialize", () => curl(api, { token, body: initialize })),
    await bench("MCP tools/list", () => curl(api, { token, body: rpc("tools/list", {}) })),
  ];
  console.table(rows);
}

if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 1000) {
  throw new Error("CANVAS_BENCH_SAMPLES must be an integer from 1 to 1000.");
}
const { CANVAS_BENCH_API: api, CANVAS_BENCH_URL: share, CANVAS_BENCH_TOKEN: token } = process.env;
if (api || share || token) {
  if (!api || !share || !token) throw new Error("Set CANVAS_BENCH_API, CANVAS_BENCH_URL and CANVAS_BENCH_TOKEN together.");
  if (new URL(api).protocol !== "https:" || new URL(share).protocol !== "https:") {
    throw new Error("The remote benchmark requires HTTPS endpoints.");
  }
  await measure(api, share, token);
} else {
  const { localClientToken, startLocalRuntime } = await import("./local-runtime.mjs");
  const { runtime, apiOrigin } = await startLocalRuntime();
  try {
    const endpoint = new URL("/mcp", apiOrigin).href;
    const { id } = (await call(endpoint, localClientToken, "tools/call", {
      name: "canvas_create",
      arguments: { title: "Latency fixture", html: "<!doctype html><title>Latency fixture</title><h1>Sample</h1>" },
    })).structuredContent;
    const { url } = (await call(endpoint, localClientToken, "tools/call", {
      name: "canvas_publish", arguments: { id, revision: 1 },
    })).structuredContent;
    await measure(endpoint, url, localClientToken);
  } finally {
    await runtime.dispose();
  }
}
